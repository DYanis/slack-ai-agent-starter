import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { test } from "node:test";
import { readConfig } from "../dist/config.js";
import { createHttpServer } from "../dist/http.js";
import { isSignedRequest, parseSlackEvent, postSlackReply, verifySlackBot } from "../dist/slack.js";
import { processJob, startWorker } from "../dist/worker.js";

const installation = { appId: "AEXAMPLE", teamId: "TEXAMPLE", botUserId: "UBOT" };
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

test("accepts a human DM reply shared with the main conversation", () => {
  const dm = {
    ...envelope.event, type: "message", subtype: "thread_broadcast",
    channel_type: "im", channel: "DEXAMPLE", thread_ts: "1700000000.000001",
  };
  const result = parseSlackEvent({ ...envelope, event: dm }, installation);
  assert.equal(result.kind, "input");
  assert.equal(result.input.threadTs, dm.thread_ts);
  assert.equal(parseSlackEvent({ ...envelope, event: { ...dm, bot_id: "BBOT" } }, installation).kind,
    "ignore");
  assert.equal(parseSlackEvent({ ...envelope, event: { ...dm, display_as_bot: true } }, installation).kind,
    "ignore");
  assert.equal(parseSlackEvent({ ...envelope, event: { ...dm, thread_ts: undefined } }, installation).kind,
    "ignore");
});

test("file support accepts files only on eligible human messages and can be disabled", () => {
  const files = [{ id: "FDEMO", url_private: "https://example.invalid" }, { id: "FDEMO" }];
  const mention = { ...envelope, event: { ...envelope.event, files } };
  const fileOnly = {
    type: "message", channel_type: "im", channel: "DEXAMPLE", user: "UEXAMPLE",
    ts: "1700000000.000004", thread_ts: "1700000000.000001", text: "", files,
  };
  assert.equal(parseSlackEvent(mention, installation).input.fileIds, undefined);
  assert.equal(parseSlackEvent({ ...envelope, event: fileOnly }, installation).kind, "ignore");
  const caption = parseSlackEvent({
    ...envelope, event: { ...fileOnly, subtype: "file_share", text: "Just the caption" },
  }, installation, false);
  assert.equal(caption.input.text, "Just the caption");
  assert.equal(caption.input.fileIds, undefined);
  assert.deepEqual(parseSlackEvent(mention, installation, true).input.fileIds, ["FDEMO"]);
  for (const event of [
    fileOnly, { ...fileOnly, text: undefined }, { ...fileOnly, subtype: "file_share", upload: false },
  ]) {
    const parsed = parseSlackEvent({ ...envelope, event }, installation, true);
    assert.equal(parsed.kind, "input");
    assert.equal(parsed.input.text, "");
    assert.equal(parsed.input.threadTs, fileOnly.thread_ts);
    assert.deepEqual(parsed.input.fileIds, ["FDEMO"]);
    assert.equal("files" in parsed.input, false);
  }
  for (const event of [
    { ...fileOnly, bot_id: "BBOT" }, { ...fileOnly, subtype: "message_changed" },
    { ...fileOnly, type: "file_shared" }, { ...fileOnly, files: [{ id: "http://example.invalid" }] },
    { ...fileOnly, text: null }, { ...fileOnly, channel_type: "channel", channel: "CEXAMPLE" },
    { ...fileOnly, subtype: "thread_broadcast", root: { files } },
  ]) assert.equal(parseSlackEvent({ ...envelope, event }, installation, true).kind, "ignore");
  assert.equal(parseSlackEvent({ ...mention, is_ext_shared_channel: true }, installation, true).kind,
    "ignore");
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `F${i}` }));
  const capped = parseSlackEvent({ ...envelope, event: { ...fileOnly, files: many } }, installation, true);
  assert.deepEqual(capped.input.fileIds, ["F0", "F1", "F2", "F3"]);
});

test("ignores other installations, Slack Connect, bots, edits, out-of-scope messages and invalid input", () => {
  for (const payload of [
    { ...envelope, team_id: "TOTHER" },
    { ...envelope, api_app_id: "AOTHER" },
    { ...envelope, is_ext_shared_channel: true },
    ...[
      { bot_id: "BBOT" }, { app_id: "AOTHER" }, { bot_profile: {} }, { display_as_bot: true },
      { source_team: "TOTHER" }, { user_team: "TOTHER" },
      { subtype: "message_changed" }, { type: "message", channel_type: "channel" },
      { type: "message", channel_type: "mpim" }, { thread_ts: "1700000000.000005" },
      { text: "" }, { text: "\0" }, { text: "x".repeat(8001) },
    ].map((event) => ({ ...envelope, event: { ...envelope.event, ...event } })),
  ]) assert.equal(parseSlackEvent(payload, installation).kind, "ignore");
});

test("uses the verified bot user to reject explicit authorization mismatches and its own messages", () => {
  const accepted = [
    undefined, [{ is_bot: false, user_id: "UINSTALLER" }],
    [{ is_bot: true, user_id: "UBOT", team_id: null }],
    [{ is_bot: true, user_id: "UBOT", team_id: installation.teamId }],
  ];
  for (const authorizations of accepted) {
    assert.equal(parseSlackEvent({ ...envelope, authorizations }, installation).kind, "input");
  }
  const authorizations = [{ is_bot: true, user_id: "UOTHERBOT", team_id: installation.teamId }];
  assert.equal(parseSlackEvent({ ...envelope, authorizations }, installation).kind, "ignore");
  assert.equal(parseSlackEvent({ ...envelope, event: { ...envelope.event, user: "UBOT" } }, installation).kind,
    "ignore");
  const enterpriseMember = { ...envelope, event: { ...envelope.event, user_team: "EEXAMPLE" } };
  assert.equal(parseSlackEvent(enterpriseMember, installation).kind, "input");
});

test("verifies the Slack bot token before binding the installation", async () => {
  const identity = { ok: true, user_id: "UBOT", bot_id: "BBOT", team_id: installation.teamId };
  const request = async (url, options) => {
    assert.equal(url, "https://slack.com/api/auth.test");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(options.redirect, "error");
    assert.equal(options.signal.aborted, false);
    return Response.json(identity);
  };
  await verifySlackBot(token, installation, request);
  for (const [result, code] of [
    [{ team_id: "TOTHER" }, "slack_installation_mismatch"],
    [{ user_id: "UOTHERBOT" }, "slack_installation_mismatch"],
    [{ app_id: "AOTHER" }, "slack_installation_mismatch"],
    [{ is_enterprise_install: true }, "slack_installation_mismatch"],
    [{ bot_id: undefined }, "slack_bot_token_invalid"],
    [{ ok: false, error: "invalid_auth" }, "slack_bot_token_invalid"],
  ]) {
    await assert.rejects(() => verifySlackBot(token, installation,
      async () => Response.json({ ...identity, ...result })), { message: code });
  }
  await assert.rejects(() => verifySlackBot(token, installation,
    async () => new Response("private error", { status: 503 })), { message: "slack_auth_unavailable" });
  for (const error of ["fatal_error", "internal_error", "org_login_required", "service_unavailable", "team_added_to_org"]) {
    await assert.rejects(() => verifySlackBot(token, installation,
      async () => Response.json({ ok: false, error })), { message: "slack_auth_unavailable" });
  }
  for (const response of [
    new Response(null, { status: 429, headers: { "retry-after": "4" } }),
    Response.json({ ok: false, error: "ratelimited" }, { headers: { "retry-after": "4" } }),
  ]) {
    await assert.rejects(() => verifySlackBot(token, installation, async () => response), {
      message: "slack_auth_unavailable", retryAfterSeconds: 4,
    });
  }
});

test("configuration rejects empty credentials, bad database URLs and excess concurrency", () => {
  const env = {
    DATABASE_URL: "postgresql://localhost/test", SLACK_APP_ID: installation.appId,
    SLACK_TEAM_ID: installation.teamId, SLACK_SIGNING_SECRET: secret, SLACK_BOT_TOKEN: token,
    SLACK_BOT_USER_ID: installation.botUserId,
  };
  assert.equal(readConfig(env).concurrency, 4);
  assert.equal(readConfig(env).botUserId, installation.botUserId);
  assert.equal(readConfig(env).filesEnabled, true);
  assert.equal(readConfig({ ...env, SLACK_FILES_ENABLED: "true" }).filesEnabled, true);
  assert.equal(readConfig({ ...env, SLACK_FILES_ENABLED: "false" }).filesEnabled, false);
  assert.throws(() => readConfig({ ...env, SLACK_FILES_ENABLED: "yes" }), /SLACK_FILES_ENABLED/);
  assert.throws(() => readConfig({ ...env, SLACK_BOT_TOKEN: "" }), /SLACK_BOT_TOKEN/);
  assert.throws(() => readConfig({ ...env, SLACK_BOT_USER_ID: undefined }), /SLACK_BOT_USER_ID/);
  assert.throws(() => readConfig({ ...env, SLACK_BOT_USER_ID: "BBOT" }), /SLACK_BOT_USER_ID/);
  assert.throws(() => readConfig({ ...env, WORKER_CONCURRENCY: "9" }), /WORKER_CONCURRENCY/);
  assert.throws(() => readConfig({ ...env, DATABASE_URL: "postgresql://[invalid" }), /DATABASE_URL/);
  for (const url of ["postgresql://", "postgresql:///"]) {
    assert.throws(() => readConfig({ ...env, DATABASE_URL: url }), /DATABASE_URL/);
  }
  for (const url of [
    "postgresql://postgres@localhost:5432",
    "postgresql:///?user=postgres&port=6543",
    "postgresql:///test?host=/tmp",
  ]) {
    assert.equal(readConfig({ ...env, DATABASE_URL: url }).databaseUrl, url);
  }
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
    Response.json({ ok: false, error: "rate_limited" }, { headers: { "retry-after": "17" } }),
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
  for (const code of ["not_in_channel", "restricted_action_thread_locked", "token_expired"]) {
    const denied = await postSlackReply(token, job, "test",
      async () => Response.json({ ok: false, error: code }));
    assert.deepEqual(denied, { kind: "failed", code });
  }
});

test("HTTP checks signatures, acknowledges only persisted events and reports readiness", async (t) => {
  const monotonicNow = performance.now.bind(performance);
  let elapsed = 0;
  t.mock.method(performance, "now", () => monotonicNow() + elapsed);
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
  elapsed += 1000;
  assert.equal((await fetch(base + "/health/ready")).status, 503);
  available = true;
  elapsed += 1000;
  assert.equal((await fetch(base + "/health/ready")).status, 200);
  assert.equal((await fetch(base + "/health/live")).status, 200);
});

test("rejects malformed and stale Slack headers without waiting for a missing body", async (t) => {
  const server = createHttpServer({
    installation, signingSecret: secret, ready: async () => {},
    enqueue: async () => assert.fail("unsigned event was enqueued"), wake: () => {},
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const headers of [
    { ...signed(body), "x-slack-signature": "garbage" },
    signed(body, Date.now() - 301_000),
  ]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(base + "/slack/events", {
        method: "POST", headers: { ...headers, "content-length": body.length },
      }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on("error", reject);
      req.setTimeout(1500, () => req.destroy(new Error("server waited for the body")));
      req.flushHeaders();
    });
    assert.equal(status, 401);
  }
});

test("shares a pending readiness check and briefly reuses its result", async (t) => {
  const release = Promise.withResolvers();
  const started = Promise.withResolvers();
  let checks = 0;
  const server = createHttpServer({
    installation, signingSecret: secret, enqueue: async () => false, wake: () => {},
    ready: async () => { checks++; started.resolve(); await release.promise; },
  }).listen(0, "127.0.0.1");
  t.after(() => {
    release.resolve();
    return new Promise((resolve) => server.close(resolve));
  });
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const first = fetch(base + "/health/ready");
  await started.promise;
  const requestReceived = once(server, "request");
  const other = fetch(base + "/health/ready");
  await requestReceived;
  await new Promise((resolve) => setImmediate(resolve));
  const checksWhilePending = checks;
  release.resolve();
  assert.deepEqual((await Promise.all([first, other])).map((res) => res.status), [200, 200]);
  assert.equal((await fetch(base + "/health/ready")).status, 200);
  assert.equal(checksWhilePending, 1);
  assert.equal(checks, 1);
});

const job = {
  eventId: "EvWorker", attemptId: "test-attempt", userId: "UTEST", text: "input",
  channelId: "CTEST", threadTs: "1700000000.000001", messageTs: "1700000000.000001", reply: null,
  fileIds: [],
};
const sent = { kind: "delivered", timestamp: "1700000000.000002" };

test("queued files respect the worker flag and incomplete downloads get a reply", async () => {
  const withFiles = { ...job, fileIds: ["FDEMO"] };
  const replies = [];
  const queue = {
    reserveSend: async () => true, finishSend: async () => {},
    generationFailed: async () => assert.fail("the user should get a reply"),
  };
  const deliver = async (_job, reply) => { replies.push(reply); return sent; };
  await processJob(queue, withFiles, async (input) => {
    assert.equal(input.text, "input");
    assert.equal("fileIds" in input || "files" in input, false);
    return "text reply";
  }, deliver);
  const noAgent = async () => assert.fail("the agent should not receive missing files");
  await processJob(queue, { ...withFiles, text: "" }, noAgent, deliver);
  await processJob(queue, withFiles, noAgent, deliver, async () => {
    throw new Error("file missing");
  });
  await processJob(queue, withFiles, noAgent, deliver, async () => {
    throw new Error("slack_files_missing_scope");
  });
  await processJob(queue, withFiles, noAgent, deliver, async () => {
    throw new Error("slack_file_share_unconfirmed");
  });
  assert.equal(replies[0], "text reply");
  assert.match(replies[1], /File support is turned off/);
  assert.match(replies[2], /couldn't read all the attached files/);
  assert.match(replies[3], /grant files:read and reinstall/);
  assert.match(replies[4], /verify the file on this message/);
});

test("finishes an in-flight claim when shutdown starts", async () => {
  const claiming = Promise.withResolvers();
  const claimed = Promise.withResolvers();
  let receipt;
  const worker = startWorker({
    recover: async () => {}, prune: async () => {},
    claim: async () => { claiming.resolve(); return claimed.promise; },
    reserveSend: async () => true,
    finishSend: async (_job, outcome) => { receipt = outcome; },
  }, 1, async () => "reply", async () => sent);
  await claiming.promise;
  const stopping = worker.stop();
  claimed.resolve(job);
  await stopping;
  assert.deepEqual(receipt, sent);
});

test("keeps claiming when recovery and cleanup fail", async (t) => {
  t.mock.method(console, "error", () => {});
  const received = Promise.withResolvers();
  const worker = startWorker({
    recover: async () => { throw new Error("recovery unavailable"); },
    prune: async () => { throw new Error("cleanup unavailable"); },
    claim: async () => job,
    reserveSend: async () => true,
    finishSend: async (_job, outcome) => { received.resolve(outcome); },
  }, 1, async () => "reply", async () => sent);
  try {
    assert.deepEqual(await Promise.race([
      received.promise,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        void received.promise.then(() => clearTimeout(timer));
      }),
    ]), sent);
  } finally {
    await worker.stop();
  }
});

test("runs recovery and cleanup even while fast jobs keep coming", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const loaded = Promise.withResolvers();
  let claims = 0;
  let recoveries = 0;
  let prunes = 0;
  const worker = startWorker({
    recover: async () => { recoveries++; },
    prune: async () => { prunes++; },
    claim: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      clock += 30_000;
      if (++claims === 5) loaded.resolve();
      return { ...job, reply: "already generated" };
    },
    reserveSend: async () => true,
    finishSend: async () => {},
  }, 2, async () => assert.fail("saved reply was regenerated"), async () => sent);
  await loaded.promise;
  await worker.stop();
  assert(recoveries > 1, "recovery was starved by claims");
  assert(prunes > 1, "cleanup was starved by claims");
});

test("times out an adapter that ignores abort and discards its late reply", async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => controller.signal);
  const started = Promise.withResolvers();
  const late = Promise.withResolvers();
  const failures = [];
  let sends = 0;
  const running = processJob({
    generationFailed: async (_job, retry) => { failures.push(retry); },
    reserveSend: async () => { sends++; return false; },
  }, job, async (_job, signal) => {
    assert.equal(signal, controller.signal);
    started.resolve();
    return late.promise;
  }, async () => assert.fail("expired reply delivered"));
  await started.promise;
  controller.abort();
  // Wait a turn to check recovery before the deliberately late adapter finishes.
  await new Promise((resolve) => setImmediate(resolve));
  const recordedBeforeLateReply = failures.slice();
  late.resolve("late reply");
  await running;
  assert.deepEqual(recordedBeforeLateReply, [true]);
  assert.equal(sends, 0);
});

test("rejects a late result even if the abort timer could not run yet", async (t) => {
  const now = performance.now.bind(performance);
  let elapsed = 0;
  t.mock.method(performance, "now", () => now() + elapsed);
  const failures = [];
  let reserved = false;
  await processJob({
    generationFailed: async (_job, retry) => { failures.push(retry); },
    reserveSend: async () => { reserved = true; return false; },
  }, job, async (_job, signal) => {
    elapsed = 25_001;
    assert.equal(signal.aborted, false);
    return "late reply";
  }, async () => assert.fail("expired reply delivered"));
  assert.deepEqual(failures, [true]);
  assert.equal(reserved, false);
});

test("retries storing a known Slack receipt without repeating delivery", async (t) => {
  t.mock.method(console, "warn", () => {});
  let sends = 0;
  const receipts = [];
  const rateLimit = { kind: "rate_limited", retryAfterSeconds: 17 };
  await processJob({
    reserveSend: async () => true,
    finishSend: async (_job, outcome, reply) => {
      receipts.push({ outcome, reply });
      if (receipts.length === 1) throw new Error("receipt write interrupted");
    },
  }, job, async () => "reply", async () => { sends++; return rateLimit; });
  assert.equal(sends, 1);
  assert.deepEqual(receipts, Array(2).fill({ outcome: rateLimit, reply: "reply" }));
});
