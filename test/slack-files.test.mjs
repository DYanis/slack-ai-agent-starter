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
const installation = { appId: "AEXAMPLE", teamId: "TEXAMPLE" };
const channelId = "DEXAMPLE";
const fileId = "FEXAMPLE";
const fileUrl = "https://files.slack.com/files-pri/TEXAMPLE-FEXAMPLE/download/example.txt";
const metadataUrl = "https://slack.com/api/files.info?file=FEXAMPLE";

function fileResponse(file = {}) {
  return Response.json({
    ok: true, file: {
      id: fileId, mode: "hosted", is_external: false, ims: [channelId],
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
    assert.equal(options.redirect, "error");
    assert.equal(options.signal.aborted, false);
    return String(url) === metadataUrl ? fileResponse() : new Response("hello");
  });
  const files = await load(channelId, [fileId], new AbortController().signal);
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
    const [file] = await load(channelId, [fileId], new AbortController().signal);
    assert.equal(file.name, fileId);
    assert.equal(file.bytes.toString(), "hello");
  }
});

test("rejects files outside the conversation and download addresses that could misuse the token", async () => {
  for (const change of [
    { ims: ["DOTHER"] }, { id: "FOTHER" }, { mode: "external" }, { is_external: true },
    { ims: undefined, shares: { private: { DOTHER: [{ ts: "1700000000.000001" }] } } },
    { ims: undefined, shares: { private: { [channelId]: [] } } },
    { ims: undefined, shares: { private: { [channelId]: [null, {}] } } },
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
    await assert.rejects(() => load(channelId, [fileId], new AbortController().signal),
      /slack_file_unavailable|slack_file_url_untrusted/);
    assert.equal(requests, 1);
  }
});

test("redirects and missing scope cannot deliver file content", async () => {
  const urls = [];
  const load = createSlackFileLoader(token, async (url, options) => {
    urls.push(String(url));
    assert.equal(options.redirect, "error");
    return String(url) === metadataUrl ? fileResponse() : Response.redirect("https://example.invalid");
  });
  await assert.rejects(() => load(channelId, [fileId], new AbortController().signal),
    /slack_file_unavailable/);
  assert.deepEqual(urls, [metadataUrl, fileUrl]);
  const noScope = createSlackFileLoader(token, async (url) => {
    assert.equal(String(url), metadataUrl);
    return Response.json({ ok: false, error: "missing_scope" });
  });
  await assert.rejects(() => noScope(channelId, [fileId], new AbortController().signal),
    /slack_files_missing_scope/);
});

test("limits file count, combined bytes and actual streamed bytes", async () => {
  const count = createSlackFileLoader(token, async () => assert.fail("over-limit download requested"));
  await assert.rejects(() => count(channelId, [fileId, "F2", "F3", "F4"], new AbortController().signal),
    /slack_file_count_limit/);
  let canceled = false;
  const oversized = createSlackFileLoader(token, async (url) => String(url) === metadataUrl
    ? fileResponse()
    : new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from("123456")); },
      cancel() { canceled = true; },
    })));
  await assert.rejects(() => oversized(channelId, [fileId], new AbortController().signal),
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
  await assert.rejects(() => full(channelId, [fileId, "FOTHER"], new AbortController().signal),
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
    await assert.rejects(() => load(channelId, [fileId, "FOTHER"], new AbortController().signal),
      /slack_files_rate_limited/);
    await assert.rejects(() => load(channelId, [fileId], new AbortController().signal),
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
  const running = load(channelId, [fileId], controller.signal);
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

  const load = createSlackFileLoader(token, async (url) =>
    String(url) === metadataUrl ? fileResponse({
      ims: undefined,
      shares: {
        public: { CEXAMPLE: [{ ts: "1700000000.000002", thread_ts: threadTs }] },
        private: { [channelId]: [{ ts: "1700000000.000002", thread_ts: threadTs }] },
      },
    }) : new Response("hello"));
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
    String(url) === metadataUrl ? fileResponse() : new Response("hello"))(channelId, [fileId], signal);
  assert.match(await respond({ files: [file] }, signal), /received 1 file/);
});
