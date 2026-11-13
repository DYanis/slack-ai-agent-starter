import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { readConfig } from "../dist/config.js";
import { createHttpServer } from "../dist/http.js";
import { isSignedRequest, parseSlackEvent, postSlackReply } from "../dist/slack.js";

const installation = { appId: "AEXAMPLE", teamId: "TEXAMPLE" };
const secret = "exampleSignSecret";
const time = 1_700_000_000_000;
const body = Buffer.from('{"test":"é"}');
const token = "xoxb-local-test-placeholder";
function signed(body, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": "v0=" + createHmac("sha256", secret)
      .update(`v0:${timestamp}:`).update(body).digest("hex"),
  };
}

const envelope = {
  type: "event_callback", team_id: installation.teamId, api_app_id: installation.appId,
  event_id: "EvExample",
  event: {
    type: "app_mention", channel: "CEXAMPLE", user: "UEXAMPLE", ts: "1700000000.000004",
    text: "<@UBOT> Hello",
  },
};

test("validates a signature over the original bytes and rejects stale or altered requests", () => {
  const headers = signed(body, time);
  const ts = headers["x-slack-request-timestamp"];
  const signature = headers["x-slack-signature"];
  assert(isSignedRequest(secret, ts, signature, body, time));
  assert(!isSignedRequest(secret, ts, signature, Buffer.from("{}"), time));
  assert(!isSignedRequest(secret, ts, signature, body, time + 301_000));
  assert(!isSignedRequest(secret, ts, signature, body, time - 301_000));
  assert(!isSignedRequest(secret, ts, "v0=00", body, time));
});

test("accepts mentions and one-to-one DMs with the right thread", () => {
  assert.deepEqual(parseSlackEvent(envelope, installation), {
    kind: "input", input: {
      eventId: "EvExample", channelId: "CEXAMPLE", userId: "UEXAMPLE",
      threadTs: "1700000000.000004", messageTs: "1700000000.000004", text: "<@UBOT> Hello",
    },
  });
  const result = parseSlackEvent({
    ...envelope, event: {
      ...envelope.event, type: "message", channel_type: "im", channel: "DEXAMPLE",
      thread_ts: "1700000000.000001",
    },
  }, installation);
  assert.equal(result.kind, "input");
  assert.equal(result.input.threadTs, "1700000000.000001");
});

test("ignores other installations, Slack Connect, bots, edits, out-of-scope messages and invalid input", () => {
  for (const payload of [
    { ...envelope, team_id: "TOTHER" },
    { ...envelope, api_app_id: "AOTHER" },
    { ...envelope, is_ext_shared_channel: true },
    ...[
      { bot_id: "BBOT" }, { app_id: "AOTHER" }, { bot_profile: {} },
      { subtype: "message_changed" }, { type: "message", channel_type: "channel" },
      { type: "message", channel_type: "mpim" }, { thread_ts: "1700000000.000005" },
      { text: "" }, { text: "\0" }, { text: "x".repeat(8001) },
    ].map((event) => ({ ...envelope, event: { ...envelope.event, ...event } })),
  ]) assert.equal(parseSlackEvent(payload, installation).kind, "ignore");
});

test("configuration rejects empty credentials, bad database URLs and excess concurrency", () => {
  const env = {
    DATABASE_URL: "postgresql://localhost/test", SLACK_APP_ID: installation.appId,
    SLACK_TEAM_ID: installation.teamId, SLACK_SIGNING_SECRET: secret, SLACK_BOT_TOKEN: token,
  };
  assert.equal(readConfig(env).concurrency, 4);
  assert.throws(() => readConfig({ ...env, SLACK_BOT_TOKEN: "" }), /SLACK_BOT_TOKEN/);
  assert.throws(() => readConfig({ ...env, WORKER_CONCURRENCY: "9" }), /WORKER_CONCURRENCY/);
  assert.throws(() => readConfig({ ...env, DATABASE_URL: "postgresql://[invalid" }), /DATABASE_URL/);
});

test("posts plain text in the selected thread with no implicit retry", async () => {
  let calls = 0;
  const job = { channelId: "CEXAMPLE", threadTs: "1700000000.000001" };
  const result = await postSlackReply(token, job, "<!channel> sample", async (url, request) => {
    calls++;
    assert.equal(url, "https://slack.com/api/chat.postMessage");
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const body = JSON.parse(request.body);
    assert.equal(body.channel, job.channelId);
    assert.equal(body.thread_ts, job.threadTs);
    assert.equal(body.mrkdwn, false);
    assert.equal(body.link_names, false);
    assert.equal(body.text, "&lt;!channel&gt; sample");
    return Response.json({ ok: true, channel: job.channelId, ts: "1700000000.000009" });
  });
  assert.deepEqual(result, { kind: "delivered", timestamp: "1700000000.000009" });
  assert.equal(calls, 1);
});

test("classifies Slack 429 as a confirmed deferral and honors Retry-After", async () => {
  const job = { channelId: "CEXAMPLE", threadTs: "1700000000.000001" };
  for (const response of [
    new Response(null, { status: 429, headers: { "retry-after": "17" } }),
    Response.json({ ok: false, error: "ratelimited" }, { headers: { "retry-after": "17" } }),
  ]) {
    assert.deepEqual(await postSlackReply(token, job, "test", async () => response),
      { kind: "rate_limited", retryAfterSeconds: 17 });
  }
});

test("quarantines ambiguous Slack responses and recognizes definitive rejections", async () => {
  const job = { channelId: "CEXAMPLE", threadTs: "1700000000.000001" };
  for (const send of [
    async () => { throw new Error("transport reset"); },
    async () => new Response(null, { status: 503 }),
    async () => Response.json({ ok: false, error: "internal_error" }),
    async () => Response.json({ ok: true, channel: "COTHER", ts: "1700000000.000009" }),
    async () => new Response("invalid JSON"),
  ]) assert.equal((await postSlackReply(token, job, "test", send)).kind, "uncertain");
  const denied = await postSlackReply(token, job, "test",
    async () => Response.json({ ok: false, error: "not_in_channel" }));
  assert.equal(denied.kind, "failed");
});

test("HTTP checks signatures, acknowledges only persisted events and reports readiness", async (t) => {
  let wakeCount = 0;
  let received = 0;
  let available = true;
  const server = createHttpServer({
    installation, signingSecret: secret,
    ready: async () => { if (!available) throw new Error("offline"); },
    enqueue: async () => {
      if (!available) throw new Error("offline");
      return ++received === 1;
    },
    wake: () => wakeCount++,
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (payload, headers = signed(payload)) =>
    fetch(base + "/slack/events", { method: "POST", headers, body: payload });

  const input = JSON.stringify(envelope);
  assert.equal((await post(input, {})).status, 401);
  assert.equal((await post("x".repeat(256 * 1024 + 1))).status, 413);
  assert.equal((await post("{")).status, 400);
  const challenge = await post(JSON.stringify({ type: "url_verification", challenge: "demo" }));
  assert.deepEqual(await challenge.json(), { challenge: "demo" });
  assert.equal((await post(input)).status, 200);
  assert.equal((await post(input)).status, 200);
  assert.equal(received, 2);
  assert.equal(wakeCount, 1);
  assert.equal((await fetch(base + "/health/ready")).status, 200);
  available = false;
  assert.equal((await post(input)).status, 503);
  assert.equal((await fetch(base + "/health/ready")).status, 503);
  assert.equal((await fetch(base + "/health/live")).status, 200);
});
