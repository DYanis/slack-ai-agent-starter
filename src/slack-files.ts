import { asRecord, maxSlackFiles, retryAfter, slackFileId } from "./slack.js";
import type { SlackInput } from "./slack.js";

export type SlackFile = Readonly<{
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}>;

type SlackFileMessage = Pick<SlackInput, "channelId" | "messageTs" | "threadTs">;

export type LoadSlackFiles = (
  message: SlackFileMessage, fileIds: readonly string[], signal: AbortSignal,
) => Promise<readonly SlackFile[]>;

const maxFileBytes = 8 * 1024 * 1024;
const maxMetadataBytes = 256 * 1024;
const fileBudgetMs = 8000;
const slackFileOrigin = "https://files.slack.com";
const slackDownloadOrigin = "https://downloads.slack-edge.com";
const downloadRedirects = new Set([301, 302, 303, 307, 308]);
const maxDownloadRedirects = 3;

function fileShare(file: Record<string, unknown>, message: SlackFileMessage): "attached" | "check_dm" | "unconfirmed" {
  const shares = asRecord(file.shares);
  const entries = [asRecord(shares?.public)?.[message.channelId], asRecord(shares?.private)?.[message.channelId]];
  if (entries.some((items) => Array.isArray(items) && items.some((entry) => {
    const share = asRecord(entry);
    return share?.ts === message.messageTs &&
      (share.thread_ts === undefined || share.thread_ts === message.threadTs);
  }))) return "attached";
  // Slack sometimes lists DM membership without a detailed share on the message.
  if (message.channelId.startsWith("D") && entries.every((item) => item === undefined) &&
      Array.isArray(file.ims) && file.ims.includes(message.channelId)) return "check_dm";
  return "unconfirmed";
}

function isSlackRateLimit(data: Record<string, unknown> | undefined): boolean {
  return data?.ok === false && (data.error === "ratelimited" || data.error === "rate_limited");
}

function isSlackFileUrl(url: URL, id: string): boolean {
  const filePath = /^\/files-pri\/[A-Z0-9]+-(F[A-Z0-9]+)\//.exec(url.pathname);
  return url.protocol === "https:" && url.origin === slackFileOrigin && filePath?.[1] === id;
}

async function readBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error("slack_file_body_missing");
  const reader = response.body.getReader();
  const bytes = Buffer.alloc(limit);
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        return bytes.subarray(0, size);
      }
      if (value.length > limit - size) throw new Error("slack_file_byte_limit");
      bytes.set(value, size);
      size += value.length;
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createSlackFileLoader(token: string, request: typeof fetch = fetch): LoadSlackFiles {
  const headers = { authorization: `Bearer ${token}` };
  let blockedUntil = 0;
  let dmLookupBlockedUntil = 0;

  function deferFiles(response: Response): never {
    blockedUntil = Math.max(blockedUntil, performance.now() + retryAfter(response.headers) * 1000);
    throw new Error("slack_files_rate_limited");
  }

  async function get(url: URL, signal: AbortSignal, redirect: "error" | "manual" = "error"): Promise<Response> {
    signal.throwIfAborted();
    if (performance.now() < blockedUntil) throw new Error("slack_files_rate_limited");
    const response = await request(url, {
      headers: url.origin === slackDownloadOrigin ? undefined : headers, redirect, signal,
    });
    if (response.ok || (redirect === "manual" && downloadRedirects.has(response.status))) return response;
    void response.body?.cancel().catch(() => {});
    if (response.status === 429) deferFiles(response);
    throw new Error("slack_file_unavailable");
  }

  async function downloadFile(url: URL, id: string, signal: AbortSignal): Promise<Response> {
    if (!isSlackFileUrl(url, id) || url.username || url.password || url.hash) {
      throw new Error("slack_file_url_untrusted");
    }
    for (let redirects = 0; ; redirects++) {
      const response = await get(url, signal, "manual");
      if (response.ok) return response;
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location || redirects >= maxDownloadRedirects) throw new Error("slack_file_redirect_unavailable");
      const next = new URL(location, url);
      // A redirect to Slack's download CDN drops credentials for the rest of the chain.
      const sameFile = url.origin === slackFileOrigin && isSlackFileUrl(next, id);
      if (next.protocol !== "https:" || next.username || next.password || next.hash ||
          (!sameFile && next.origin !== slackDownloadOrigin)) {
        throw new Error("slack_file_url_untrusted");
      }
      url = next;
    }
  }

  async function dmAttachmentIds(message: SlackFileMessage, signal: AbortSignal): Promise<Set<string>> {
    signal.throwIfAborted();
    if (performance.now() < dmLookupBlockedUntil) throw new Error("slack_files_rate_limited");
    const url = new URL("https://slack.com/api/conversations.replies");
    url.search = new URLSearchParams({
      channel: message.channelId, ts: message.threadTs, oldest: message.messageTs, latest: message.messageTs,
      inclusive: "true", limit: "2",
    }).toString();
    const response = await request(url, { headers, redirect: "error", signal });
    const data = response.ok
      ? asRecord(JSON.parse((await readBytes(response, maxMetadataBytes)).toString("utf8")))
      : undefined;
    if (!response.ok) void response.body?.cancel().catch(() => {});
    if (response.status === 429 || isSlackRateLimit(data)) {
      dmLookupBlockedUntil = Math.max(dmLookupBlockedUntil, performance.now() + retryAfter(response.headers) * 1000);
      throw new Error("slack_files_rate_limited");
    }
    const current = data?.ok === true && Array.isArray(data.messages) ? data.messages.map(asRecord).find((item) =>
      item?.type === "message" && item.ts === message.messageTs && item.hidden !== true &&
      (item.subtype === undefined || item.subtype === "file_share") &&
      (item.channel === undefined || item.channel === message.channelId) &&
      (item.thread_ts === undefined || item.thread_ts === message.threadTs)) : undefined;
    const ids = new Set<string>();
    if (Array.isArray(current?.files)) {
      for (const file of current.files) {
        const id = asRecord(file)?.id;
        if (typeof id === "string" && slackFileId.test(id)) ids.add(id);
      }
    }
    return ids;
  }

  return async (message, fileIds, signal) => {
    if (fileIds.length > maxSlackFiles) throw new Error("slack_file_count_limit");
    const fileSignal = AbortSignal.any([signal, AbortSignal.timeout(fileBudgetMs)]);
    const files: SlackFile[] = [];
    let dmFileIds: Set<string> | undefined;
    let remaining = maxFileBytes;
    for (const id of fileIds) {
      if (!slackFileId.test(id)) throw new Error("invalid_slack_file_id");
      const info = new URL("https://slack.com/api/files.info");
      info.searchParams.set("file", id);
      const response = await get(info, fileSignal);
      const data = asRecord(JSON.parse((await readBytes(response, maxMetadataBytes)).toString("utf8")));
      if (isSlackRateLimit(data)) deferFiles(response);
      if (data?.ok === false && data.error === "missing_scope") {
        throw new Error("slack_files_missing_scope");
      }
      const file = asRecord(data?.file);
      if (data?.ok !== true || !file || file.id !== id ||
          (file.mode !== "hosted" && file.mode !== "snippet") ||
          file.is_external === true || file.filetype === "remote" ||
          typeof file.size !== "number" || !Number.isSafeInteger(file.size) ||
          file.size < 0 || file.size > remaining) throw new Error("slack_file_unavailable");
      const share = fileShare(file, message);
      if (share === "check_dm") dmFileIds ??= await dmAttachmentIds(message, fileSignal);
      if (share !== "attached" && (share !== "check_dm" || !dmFileIds?.has(id))) {
        throw new Error("slack_file_share_unconfirmed");
      }

      const download = file.url_private_download ?? file.url_private;
      if (typeof download !== "string") throw new Error("slack_file_url_missing");
      // Remote file metadata can contain a URL chosen by another app.
      const bytes = await readBytes(await downloadFile(new URL(download), id, fileSignal), file.size);
      if (bytes.length !== file.size) throw new Error("slack_file_size_mismatch");
      remaining -= bytes.length;
      const name = typeof file.name === "string" && file.name.trim() && file.name.length <= 255 &&
        !/[\u0000-\u001f\u007f/\\]/.test(file.name) && file.name !== "." && file.name !== ".."
        ? file.name
        : id;
      const mimeType = typeof file.mimetype === "string" &&
        /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(file.mimetype) && file.mimetype.length <= 127
        ? file.mimetype
        : "application/octet-stream";
      files.push({ name, mimeType, bytes });
    }
    fileSignal.throwIfAborted();
    return files;
  };
}
