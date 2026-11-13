import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { createAgent, respond } from "../dist/agent.js";
import { readConfig } from "../dist/config.js";
import { createHttpServer } from "../dist/http.js";
import { createSlackFileLoader } from "../dist/slack-files.js";
import { postSlackReply } from "../dist/slack.js";
import { processJob } from "../dist/worker.js";

const token = "xoxb-local-fixture";
const secret = "localFixtureSecret";
const installation = { appId: "AEXAMPLE", teamId: "TEXAMPLE", botUserId: "UBOT" };
const channelId = "DEXAMPLE";
const fileMessage = { channelId, messageTs: "1700000000.000002", threadTs: "1700000000.000001" };
const fileId = "FEXAMPLE";
const fileUrl = "https://files.slack.com/files-pri/TEXAMPLE-FEXAMPLE/download/example.txt";
const metadataUrl = "https://slack.com/api/files.info?file=FEXAMPLE";
const repliesUrl = "https://slack.com/api/conversations.replies";

function fileResponse(file = {}) {
  return Response.json({
    ok: true, file: {
      id: fileId, mode: "hosted", is_external: false,
      shares: { private: { [channelId]: [{ ts: fileMessage.messageTs, thread_ts: fileMessage.threadTs }] } },
      name: "example.txt", size: 5, mimetype: "text/plain", url_private_download: fileUrl,
      ...file,
    },
  });
}

test("uses the signed message file ID and downloads from the matching Slack host", async () => {
  const urls = [];
  const load = createSlackFileLoader(token, async (url, options) => {
    urls.push(String(url));
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.redirect, String(url) === metadataUrl ? "error" : "manual");
    assert.equal(options.signal.aborted, false);
    return String(url) === metadataUrl ? fileResponse() : new Response("hello");
  });
  const files = await load(fileMessage, [fileId], new AbortController().signal);
  assert.deepEqual(urls, [metadataUrl, fileUrl]);
  assert.deepEqual(files, [{ name: "example.txt", mimeType: "text/plain", bytes: Buffer.from("hello") }]);
});

test("accepts an unnamed Slack snippet and uses a safe fallback for file names", async () => {
  const snippetUrl = "https://files.slack.com/files-pri/TEXAMPLE-FEXAMPLE/example.txt";
  for (const name of [null, "../outside.txt", "bad\u0000name"]) {
    const load = createSlackFileLoader(token, async (url) => {
      if (String(url) === metadataUrl) {
        return fileResponse({ name, mode: "snippet", url_private_download: undefined,
          url_private: snippetUrl });
      }
      assert.equal(String(url), snippetUrl);
      return new Response("hello");
    });
    const [file] = await load(fileMessage, [fileId], new AbortController().signal);
    assert.equal(file.name, fileId);
    assert.equal(file.bytes.toString(), "hello");
  }
});

test("rejects files not attached to this message and download addresses that could misuse the token", async () => {
  for (const change of [
    { shares: undefined, ims: ["DOTHER"] },
    { shares: { private: { [channelId]: [{ ts: "1700000000.000003" }] } }, ims: [channelId] },
    { shares: { private: { [channelId]: [{ ts: fileMessage.messageTs, thread_ts: fileMessage.messageTs }] } } },
    { shares: { private: { [channelId]: [] } }, ims: [channelId] },
    { shares: { private: { [channelId]: null } }, ims: [channelId] },
    { shares: { private: { [channelId]: [null, {}] } } },
    { id: "FOTHER" }, { mode: "external" }, { is_external: true },
    { filetype: "remote" },
    { url_private_download: "https://files.slack.com.example.invalid/files-pri/TEXAMPLE-FEXAMPLE/x" },
    { url_private_download: "https://files.slack.com@other.invalid/files-pri/TEXAMPLE-FEXAMPLE/x" },
    { url_private_download: "https://user@files.slack.com/files-pri/TEXAMPLE-FEXAMPLE/x" },
    { url_private_download: "https://files.slack.com:444/files-pri/TEXAMPLE-FEXAMPLE/x" },
    { url_private_download: "http://files.slack.com/files-pri/TEXAMPLE-FEXAMPLE/x" },
    { url_private_download: "https://files.slack.com/files-pri/TEXAMPLE-FOTHER/x" },
    { url_private_download: "https://files.slack.com/unrelated/TEXAMPLE-FEXAMPLE/x" },
  ]) {
    let requests = 0;
    const load = createSlackFileLoader(token, async (url) => {
      assert.equal(String(url), metadataUrl);
      requests++;
      return fileResponse(change);
    });
    await assert.rejects(() => load(fileMessage, [fileId], new AbortController().signal),
      /slack_file_unavailable|slack_file_share_unconfirmed|slack_file_url_untrusted/);
    assert.equal(requests, 1);
  }
});

test("checks the exact DM message once for files with only DM share metadata", async () => {
  const otherFileId = "FOTHER";
  const otherFileUrl = fileUrl.replace(fileId, otherFileId);
  const signal = new AbortController().signal;
  for (const message of [fileMessage, { ...fileMessage, threadTs: fileMessage.messageTs }]) {
    const requests = [];
    const load = createSlackFileLoader(token, async (url, options) => {
      requests.push(String(url));
      if (url.pathname === "/api/files.info") {
        const id = url.searchParams.get("file");
        assert([fileId, otherFileId].includes(id));
        return fileResponse({ id, shares: undefined, ims: [channelId],
          url_private_download: id === fileId ? fileUrl : otherFileUrl });
      }
      if (url.pathname === "/api/conversations.replies") {
        assert.equal(url.origin + url.pathname, repliesUrl);
        assert.deepEqual(Object.fromEntries(url.searchParams), {
          channel: channelId, ts: message.threadTs, oldest: message.messageTs, latest: message.messageTs,
          inclusive: "true", limit: "2",
        });
        assert.equal(options.headers.authorization, `Bearer ${token}`);
        assert.equal(options.redirect, "error");
        const attachmentMessage = {
          type: "message", subtype: "file_share", ts: message.messageTs,
          files: [{ id: fileId }, { id: otherFileId }, { id: "FNOTREQUESTED" }],
        };
        const messages = message.threadTs === message.messageTs ? [attachmentMessage] : [
          { type: "message", ts: message.threadTs },
          { ...attachmentMessage, thread_ts: message.threadTs },
        ];
        return Response.json({ ok: true, messages });
      }
      assert([fileUrl, otherFileUrl].includes(String(url)));
      return new Response("hello");
    });
    const files = await load(message, [fileId, otherFileId], signal);
    assert.deepEqual(files.map((file) => file.bytes.toString()), ["hello", "hello"]);
    assert.equal(requests.filter((url) => url.startsWith(repliesUrl)).length, 1);
    assert.equal(requests.length, 5);
  }
});

test("a partial Slack share list cannot hide or substitute the exact DM attachment", async () => {
  const signal = new AbortController().signal;
  for (const flag of ["has_more_shares", "skipped_shares"]) {
    let currentId = fileId;
    let downloads = 0;
    const load = createSlackFileLoader(token, async (url) => {
      if (String(url) === metadataUrl) return fileResponse({
        shares: { private: { [channelId]: [{ ts: fileMessage.threadTs }] } },
        ims: [channelId], [flag]: true,
      });
      if (url.origin + url.pathname === repliesUrl) return Response.json({
        ok: true, messages: [{ type: "message", ts: fileMessage.messageTs, files: [{ id: currentId }] }],
      });
      assert.equal(String(url), fileUrl);
      downloads++;
      return new Response("hello");
    });
    assert.equal((await load(fileMessage, [fileId], signal))[0].bytes.toString(), "hello");
    currentId = "FOTHER";
    await assert.rejects(() => load(fileMessage, [fileId], signal), /slack_file_share_unconfirmed/);
    assert.equal(downloads, 1);
  }
});

test("does not download a DM file when the exact message no longer contains it", async () => {
  const attached = { type: "message", ts: fileMessage.messageTs, files: [{ id: fileId }] };
  const signal = new AbortController().signal;
  for (const data of [
    { ok: false, error: "thread_not_found" },
    { ok: true, messages: [] },
    { ok: true, messages: [{ ...attached, ts: fileMessage.threadTs }, { ...attached, files: [{ id: "FOTHER" }] }] },
    { ok: true, messages: [{ ...attached, hidden: true }] },
    { ok: true, messages: [{ ...attached, channel: "DOTHER" }] },
    { ok: true, messages: [{ ...attached, thread_ts: fileMessage.messageTs }] },
    { ok: true, messages: [{ ...attached, subtype: "tombstone" }] },
  ]) {
    const load = createSlackFileLoader(token, async (url) => {
      if (String(url) === metadataUrl) return fileResponse({ shares: undefined, ims: [channelId] });
      assert.equal(url.origin + url.pathname, repliesUrl);
      return Response.json(data);
    });
    await assert.rejects(() => load(fileMessage, [fileId], signal), /slack_file_share_unconfirmed/);
  }
  const channel = { ...fileMessage, channelId: "CEXAMPLE" };
  const channelLoader = createSlackFileLoader(token, async (url) => {
    assert.equal(String(url), metadataUrl);
    return fileResponse({ shares: undefined, channels: [channel.channelId], ims: [channel.channelId] });
  });
  await assert.rejects(() => channelLoader(channel, [fileId], signal), /slack_file_share_unconfirmed/);
});

test("a rate limit on the DM lookup does not block a confirmed file share", async () => {
  const signal = new AbortController().signal;
  for (const status of [200, 429]) {
    let lookups = 0;
    let detailed = false;
    const load = createSlackFileLoader(token, async (url) => {
      if (String(url) === metadataUrl) return detailed ? fileResponse() : fileResponse({ shares: undefined, ims: [channelId] });
      if (String(url) === fileUrl) return new Response("hello");
      assert.equal(url.origin + url.pathname, repliesUrl);
      lookups++;
      return Response.json({ ok: false, error: "ratelimited" }, { status, headers: { "retry-after": "60" } });
    });
    await assert.rejects(() => load(fileMessage, [fileId], signal), /slack_files_rate_limited/);
    await assert.rejects(() => load(fileMessage, [fileId], signal), /slack_files_rate_limited/);
    assert.equal(lookups, 1);
    detailed = true;
    assert.equal((await load(fileMessage, [fileId], signal))[0].bytes.toString(), "hello");
  }
});

test("only bounded Slack download redirects are followed", async () => {
  const sameFilePath = "/files-pri/TEXAMPLE-FEXAMPLE/example.txt";
  const sameFileUrl = "https://files.slack.com" + sameFilePath;
  const cdnUrl = "https://downloads.slack-edge.com/private-file?signature=fixture";
  const urls = [];
  const load = createSlackFileLoader(token, async (url, options) => {
    urls.push(String(url));
    if (String(url) === metadataUrl) {
      assert.equal(options.redirect, "error");
      return fileResponse();
    }
    assert.equal(options.redirect, "manual");
    assert.equal(new Headers(options.headers).get("authorization"),
      String(url) === cdnUrl ? null : `Bearer ${token}`);
    if (String(url) === fileUrl) return new Response(null, { status: 302, headers: { location: sameFilePath } });
    if (String(url) === sameFileUrl) return Response.redirect(cdnUrl);
    assert.equal(String(url), cdnUrl);
    return new Response("hello");
  });
  const signal = new AbortController().signal;
  const [file] = await load(fileMessage, [fileId], signal);
  assert.equal(file.bytes.toString(), "hello");
  assert.deepEqual(urls, [metadataUrl, fileUrl, sameFileUrl, cdnUrl]);

  for (const target of [
    "https://example.invalid", "https://downloads.slack-edge.com.example.invalid/file",
    "https://files.slack.com/files-pri/TEXAMPLE-FOTHER/download/example.txt",
    "http://downloads.slack-edge.com/file", "https://user@downloads.slack-edge.com/file",
    "blob:https://downloads.slack-edge.com/example",
  ]) {
    const blocked = createSlackFileLoader(token, async (url) => {
      if (String(url) === metadataUrl) return fileResponse();
      assert.equal(String(url), fileUrl);
      return Response.redirect(target);
    });
    await assert.rejects(() => blocked(fileMessage, [fileId], signal), /slack_file_url_untrusted/);
  }

  let hops = 0;
  const loop = createSlackFileLoader(token, async (url) => {
    if (String(url) === metadataUrl) return fileResponse();
    hops++;
    return Response.redirect(fileUrl);
  });
  await assert.rejects(() => loop(fileMessage, [fileId], signal), /slack_file_redirect_unavailable/);
  assert.equal(hops, 4);
  const cdnLoop = createSlackFileLoader(token, async (url, options) => {
    if (String(url) === metadataUrl) return fileResponse();
    if (String(url) === fileUrl) return Response.redirect(cdnUrl);
    assert.equal(String(url), cdnUrl);
    assert.equal(new Headers(options.headers).has("authorization"), false);
    return Response.redirect(fileUrl);
  });
  await assert.rejects(() => cdnLoop(fileMessage, [fileId], signal), /slack_file_url_untrusted/);
});

test("metadata redirects and missing scope cannot deliver file content", async () => {
  const redirected = createSlackFileLoader(token, async (url, options) => {
    assert.equal(String(url), metadataUrl);
    assert.equal(options.redirect, "error");
    return Response.redirect("https://example.invalid");
  });
  await assert.rejects(() => redirected(fileMessage, [fileId], new AbortController().signal),
    /slack_file_unavailable/);
  const noScope = createSlackFileLoader(token, async (url) => {
    assert.equal(String(url), metadataUrl);
    return Response.json({ ok: false, error: "missing_scope" });
  });
  await assert.rejects(() => noScope(fileMessage, [fileId], new AbortController().signal),
    /slack_files_missing_scope/);
});

test("limits file count, combined bytes and actual streamed bytes", async () => {
  const count = createSlackFileLoader(token, async () => assert.fail("over-limit download requested"));
  await assert.rejects(() => count(fileMessage, [fileId, "F2", "F3", "F4"], new AbortController().signal),
    /slack_file_count_limit/);
  let canceled = false;
  const oversized = createSlackFileLoader(token, async (url) => String(url) === metadataUrl
    ? fileResponse()
    : new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from("123456")); },
      cancel() { canceled = true; },
    })));
  await assert.rejects(() => oversized(fileMessage, [fileId], new AbortController().signal),
    /slack_file_byte_limit/);
  assert.equal(canceled, true);

  const urls = [];
  const full = createSlackFileLoader(token, async (url) => {
    urls.push(String(url));
    if (String(url) === metadataUrl) return fileResponse({ size: 8 * 1024 * 1024 });
    if (String(url) === fileUrl) return new Response(Buffer.alloc(8 * 1024 * 1024));
    assert.equal(url.searchParams.get("file"), "FOTHER");
    return fileResponse({ id: "FOTHER", size: 1,
      url_private_download: "https://files.slack.com/files-pri/TEXAMPLE-FOTHER/download/other.txt" });
  });
  await assert.rejects(() => full(fileMessage, [fileId, "FOTHER"], new AbortController().signal),
    /slack_file_unavailable/);
  assert.deepEqual(urls, [metadataUrl, fileUrl, "https://slack.com/api/files.info?file=FOTHER"]);
});

test("honors Slack file rate limits across jobs without retrying immediately", async () => {
  for (const result of [
    new Response(null, { status: 429, headers: { "retry-after": "15" } }),
    Response.json({ ok: false, error: "rate_limited" }, { headers: { "retry-after": "15" } }),
  ]) {
    let calls = 0;
    const load = createSlackFileLoader(token, async () => { calls++; return result; });
    await assert.rejects(() => load(fileMessage, [fileId, "FOTHER"], new AbortController().signal),
      /slack_files_rate_limited/);
    await assert.rejects(() => load(fileMessage, [fileId], new AbortController().signal),
      /slack_files_rate_limited/);
    assert.equal(calls, 1);
  }
});

test("cancels a download when the generation budget is aborted", async () => {
  const started = Promise.withResolvers();
  const controller = new AbortController();
  const load = createSlackFileLoader(token, async (url, options) => {
    if (String(url) === metadataUrl) return fileResponse();
    return new Response(new ReadableStream({
      start(stream) {
        options.signal.addEventListener("abort", () => stream.error(options.signal.reason), { once: true });
        started.resolve();
      },
    }));
  });
  const running = load(fileMessage, [fileId], controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
});

test("signed Slack attachments reach the selected model and replies stay in the original threads", async (t) => {
  const config = readConfig({
    DATABASE_URL: "postgresql://localhost/agent", SLACK_APP_ID: installation.appId,
    SLACK_TEAM_ID: installation.teamId, SLACK_SIGNING_SECRET: secret, SLACK_BOT_TOKEN: token,
    AI_PROVIDER: "openai", AI_MODEL: "fixture-model", OPENAI_API_KEY: "fixture-key",
  });
  const pending = [];
  const server = createHttpServer({
    installation, signingSecret: secret, filesEnabled: config.filesEnabled, ready: async () => {}, wake: () => {},
    enqueue: async (input) => { pending.push(input); return true; },
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const threadTs = "1700000000.000001";
  const timestamp = String(Math.floor(Date.now() / 1000));
  async function send(eventId, event, tamper = false) {
    const message = JSON.stringify({
      type: "event_callback", team_id: installation.teamId, api_app_id: installation.appId,
      event_id: eventId, event: {
        user: "UEXAMPLE", ts: "1700000000.000002", thread_ts: threadTs,
        files: [{ id: fileId }], ...event,
      },
    });
    const signature = createHmac("sha256", secret).update(`v0:${timestamp}:`).update(message).digest("hex");
    return fetch(`http://127.0.0.1:${server.address().port}/slack/events`, {
      method: "POST", body: tamper ? message + " " : message, headers: {
        "x-slack-signature": `v0=${signature}`, "x-slack-request-timestamp": timestamp,
      },
    });
  }
  const dm = { type: "message", subtype: "file_share", channel: channelId, channel_type: "im" };
  const channel = { type: "app_mention", channel: "CEXAMPLE", text: "<@UBOT> Explain the file." };
  assert.equal((await send("EvTampered", dm, true)).status, 401);
  assert.equal((await send("EvUnmentioned", { ...channel, type: "message", channel_type: "channel" })).status, 200);
  assert.equal((await send("EvFileOnly", dm)).status, 200);
  assert.equal((await send("EvMention", channel)).status, 200);
  assert.deepEqual(pending.map(({ eventId, fileIds }) => ({ eventId, fileIds })), [
    { eventId: "EvFileOnly", fileIds: [fileId] }, { eventId: "EvMention", fileIds: [fileId] },
  ]);

  const load = createSlackFileLoader(token, async (url) => {
    if (String(url) === metadataUrl) return fileResponse({
      shares: { public: { CEXAMPLE: [{ ts: fileMessage.messageTs, thread_ts: threadTs }] } },
      ims: [channelId],
    });
    if (url.origin + url.pathname === repliesUrl) return Response.json({
      ok: true, messages: [{ type: "message", ts: fileMessage.messageTs, thread_ts: threadTs, files: [{ id: fileId }] }],
    });
    assert.equal(String(url), fileUrl);
    return new Response("hello");
  });
  const prompts = [];
  const agent = createAgent(config.model, async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(options.headers.authorization, "Bearer fixture-key");
    const [message] = JSON.parse(options.body).input;
    assert.equal(message.role, "user");
    assert.deepEqual(message.content[1], { type: "input_text", text: "File: example.txt\nhello" });
    prompts.push(message.content[0].text);
    return Response.json({
      status: "completed", output: [{
        type: "message", role: "assistant", content: [{ type: "output_text", text: "I read the file." }],
      }],
    });
  });
  const delivered = [];
  const queue = {
    reserveSend: async () => true,
    finishSend: async (_job, receipt) => { assert.equal(receipt.kind, "delivered"); },
    generationFailed: async () => assert.fail("the file should reach the model"),
  };
  for (const input of pending) {
    await processJob(queue, { ...input, attemptId: "local-fixture", reply: null }, agent,
      (job, reply) => postSlackReply(token, job, reply, async (_url, options) => {
        delivered.push(JSON.parse(options.body));
        return Response.json({ ok: true, channel: job.channelId, ts: "1700000000.000003" });
      }), load);
  }
  assert.deepEqual(prompts, ["Summarize the attached files.", channel.text]);
  assert.deepEqual(delivered.map(({ channel, thread_ts, text }) => [channel, thread_ts, text]), [
    [channelId, threadTs, "I read the file."], ["CEXAMPLE", threadTs, "I read the file."],
  ]);
});

test("demo reports the file count without calling a model", async () => {
  const signal = new AbortController().signal;
  const [file] = await createSlackFileLoader(token, async (url) =>
    String(url) === metadataUrl ? fileResponse() : new Response("hello"))(fileMessage, [fileId], signal);
  assert.match(await respond({ files: [file] }, signal), /received 1 file/);
});
