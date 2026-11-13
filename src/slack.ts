import { createHmac, timingSafeEqual } from "node:crypto";

export type SlackInput = {
  eventId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  text: string;
  fileIds?: readonly string[];
};

export type Installation = { appId: string; teamId: string };

const slackTimestamp = /^\d{10,12}\.\d{6}$/;
const textLimit = 8000;
export const maxSlackFiles = 3;
export const slackFileId = /^F[A-Z0-9]{1,64}$/;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function hasFreshSignatureHeaders(timestamp: string, signature: string, now = Date.now()): boolean {
  return /^\d{10,12}$/.test(timestamp) &&
    Math.abs(Math.floor(now / 1000) - Number(timestamp)) <= 300 &&
    /^v0=[a-f0-9]{64}$/.test(signature);
}

export function isSignedRequest(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  body: Buffer,
  now = Date.now(),
): boolean {
  if (!timestamp || !signature || !hasFreshSignatureHeaders(timestamp, signature, now)) return false;
  const expected = createHmac("sha256", secret)
    .update(`v0:${timestamp}:`)
    .update(body)
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"));
}

export function parseSlackEvent(value: unknown, installation: Installation, filesEnabled = false):
  | { kind: "challenge"; challenge: string }
  | { kind: "input"; input: SlackInput }
  | { kind: "ignore" } {
  const payload = asRecord(value);
  if (payload?.type === "url_verification" &&
      typeof payload.challenge === "string" && payload.challenge.length <= 256) {
    return { kind: "challenge", challenge: payload.challenge };
  }

  const event = asRecord(payload?.event);
  if (payload?.type !== "event_callback" ||
      payload.team_id !== installation.teamId ||
      payload.api_app_id !== installation.appId ||
      payload.is_ext_shared_channel === true ||
      typeof payload.event_id !== "string" ||
      !/^Ev[A-Za-z0-9]{1,64}$/.test(payload.event_id) ||
      !event || event.bot_id || event.app_id || event.bot_profile ||
      event.display_as_bot === true) return { kind: "ignore" };

  const channelId = event.channel;
  const userId = event.user;
  const messageTs = event.ts;
  const threadTs = event.thread_ts ?? messageTs;
  if (typeof channelId !== "string" || !/^[CDG][A-Z0-9]+$/.test(channelId) ||
      typeof userId !== "string" || !/^[UW][A-Z0-9]+$/.test(userId) ||
      typeof messageTs !== "string" || !slackTimestamp.test(messageTs) ||
      typeof threadTs !== "string" || !slackTimestamp.test(threadTs) ||
      BigInt(threadTs.replace(".", "")) > BigInt(messageTs.replace(".", ""))) return { kind: "ignore" };

  const mention = event.type === "app_mention" && /^[CG]/.test(channelId);
  const dm = event.type === "message" && event.channel_type === "im" &&
    channelId.startsWith("D");
  if (!mention && !dm) return { kind: "ignore" };
  const broadcast = dm && event.subtype === "thread_broadcast" &&
    typeof event.thread_ts === "string" && threadTs !== messageTs;
  const fileShare = filesEnabled && event.subtype === "file_share";
  if (event.subtype !== undefined && !broadcast && !fileShare) return { kind: "ignore" };

  const fileIds = new Set<string>();
  if (filesEnabled && !broadcast && event.files !== undefined) {
    if (!Array.isArray(event.files)) return { kind: "ignore" };
    for (const file of event.files) {
      const id = asRecord(file)?.id;
      if (typeof id !== "string" || !slackFileId.test(id)) return { kind: "ignore" };
      fileIds.add(id);
      // Keep one extra ID so the worker can explain the limit without downloading a partial set.
      if (fileIds.size > maxSlackFiles) break;
    }
  }
  if (fileShare && !fileIds.size) return { kind: "ignore" };

  const text = fileIds.size && event.text === undefined ? "" : event.text;
  if (typeof text !== "string" || text.length > textLimit || text.includes("\0") ||
      (!text.trim() && !fileIds.size)) return { kind: "ignore" };

  return {
    kind: "input",
    input: {
      eventId: payload.event_id, channelId, threadTs, messageTs, userId, text,
      ...(fileIds.size ? { fileIds: [...fileIds] } : {}),
    },
  };
}

export type Delivery =
  | { kind: "delivered"; timestamp: string }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "failed" | "uncertain"; code: string };

const definiteRejections = new Set([
  "access_denied", "account_inactive", "channel_not_found", "invalid_arguments", "invalid_auth",
  "is_archived", "missing_scope", "msg_too_long", "no_text", "not_authed",
  "not_in_channel", "restricted_action", "restricted_action_non_threadable_channel",
  "restricted_action_read_only_channel", "restricted_action_thread_locked",
  "thread_not_found", "token_expired", "token_revoked",
]);

export function retryAfter(headers: Headers): number {
  const value = headers.get("retry-after");
  const seconds = Number(value);
  return value !== null && /^\d+$/.test(value) &&
    Number.isSafeInteger(seconds) && seconds <= 2_147_483_647
    ? Math.max(1, seconds)
    : 30;
}

export async function postSlackReply(
  token: string,
  input: Pick<SlackInput, "channelId" | "threadTs">,
  reply: string,
  send: typeof fetch = fetch,
): Promise<Delivery> {
  try {
    const response = await send("https://slack.com/api/chat.postMessage", {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: reply.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
        mrkdwn: false,
        parse: "none",
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      return { kind: "rate_limited", retryAfterSeconds: retryAfter(response.headers) };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { kind: "uncertain", code: "slack_http_unconfirmed" };
    }
    const data = asRecord(await response.json());
    if (data?.ok === true && data.channel === input.channelId &&
        typeof data.ts === "string" && slackTimestamp.test(data.ts)) {
      return { kind: "delivered", timestamp: data.ts };
    }
    if (data?.ok === false && (data.error === "ratelimited" || data.error === "rate_limited")) {
      return { kind: "rate_limited", retryAfterSeconds: retryAfter(response.headers) };
    }
    if (data?.ok === false && typeof data.error === "string" &&
        definiteRejections.has(data.error)) {
      return { kind: "failed", code: data.error };
    }
    return { kind: "uncertain", code: "slack_response_unconfirmed" };
  } catch {
    return { kind: "uncertain", code: "slack_transport_unconfirmed" };
  }
}
