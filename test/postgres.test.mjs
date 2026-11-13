import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { Queue } from "../dist/queue.js";
import { processJob, startWorker } from "../dist/worker.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
assert(databaseUrl, "Set TEST_DATABASE_URL to a disposable PostgreSQL database");
const schema = await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8");
const installation = { teamId: "TTEST", appId: "ATEST" };
const thread = "1700000000.000001";

function input(id, message, channelId = "CTEST", threadTs = thread) {
  return {
    eventId: `Ev${id}`, channelId, threadTs,
    messageTs: `1700000000.${String(message).padStart(6, "0")}`,
    userId: "UTEST", text: "synthetic input",
  };
}

async function setup(t) {
  const admin = new Pool({ connectionString: databaseUrl });
  const namespace = "test_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA ${namespace}`);
  const database = new Pool({ connectionString: databaseUrl, options: `-c search_path=${namespace}` });
  const otherDatabase = new Pool({
    connectionString: databaseUrl, options: `-c search_path=${namespace}`, statement_timeout: 2000,
  });
  t.after(async () => {
    await Promise.all([database.end(), otherDatabase.end()]);
    await admin.query(`DROP SCHEMA ${namespace} CASCADE`);
    await admin.end();
  });
  const queue = new Queue(database);
  const other = new Queue(otherDatabase);
  await Promise.all([queue.initialize(schema, installation), other.initialize(schema, installation)]);
  return { queue, other, database };
}

async function state(database, eventId) {
  return (await database.query("SELECT * FROM slack_jobs WHERE event_id = $1", [eventId])).rows[0];
}

const sent = { kind: "delivered", timestamp: "1700000000.000100" };

test("deduplicates Slack retries and the same message under a different event ID", async (t) => {
  const { queue, other } = await setup(t);
  const first = { ...input("One", 1), fileIds: ["FONE"] };
  assert.equal((await Promise.all([queue.enqueue(first), other.enqueue(first)])).filter(Boolean).length, 1);
  assert.equal(await other.enqueue({ ...first, eventId: "EvOther", fileIds: ["FOTHER"] }), false);
  assert.deepEqual((await queue.claim()).fileIds, ["FONE"]);
  await assert.rejects(() => queue.initialize(schema, { teamId: "TOTHER", appId: "AOTHER" }),
    /database_installation_mismatch/);
});

test("upgrades a database created before file support and preserves its jobs", async (t) => {
  const { queue, other, database } = await setup(t);
  await database.query("ALTER TABLE slack_jobs DROP COLUMN file_ids");
  await database.query(
    `INSERT INTO slack_jobs (event_id, channel_id, thread_ts, message_ts, user_id, input_text)
     VALUES ('EvLegacy', 'CTEST', $1, $1, 'UTEST', 'legacy text')`, [thread],
  );
  await Promise.all([queue.initialize(schema, installation), other.initialize(schema, installation)]);
  const job = await queue.claim();
  assert.equal(job.eventId, "EvLegacy");
  assert.equal(job.text, "legacy text");
  assert.deepEqual(job.fileIds, []);
});

test("serializes one thread and runs independent threads concurrently", async (t) => {
  const { queue, other } = await setup(t);
  await queue.enqueue(input("Second", 2));
  await queue.enqueue(input("First", 1));
  await queue.enqueue(input("Separate", 1, "COTHER"));
  const jobs = await Promise.all([queue.claim(), other.claim()]);
  assert.deepEqual(jobs.map((job) => job.eventId).sort(), ["EvFirst", "EvSeparate"]);
  assert.equal(await other.claim(), undefined);
  const first = jobs.find((job) => job.eventId === "EvFirst");
  assert(await queue.reserveSend(first, "first reply"));
  await queue.finishSend(first, sent, "first reply");
  assert.equal((await other.claim()).eventId, "EvSecond");
});

test("an older late event waits for the already active thread", async (t) => {
  const { queue, other } = await setup(t);
  await queue.enqueue(input("FirstSeen", 3));
  const active = await queue.claim();
  await other.enqueue(input("Late", 1));
  assert.equal(await other.claim(), undefined);
  assert(await queue.reserveSend(active, "reply"));
  assert.equal(await other.claim(), undefined);
  await queue.finishSend(active, sent, "reply");
  assert.equal((await other.claim()).eventId, "EvLate");
});

test("a deferred head holds newer messages in the same thread", async (t) => {
  const { queue, other, database } = await setup(t);
  await queue.enqueue({ ...input("Head", 1), fileIds: ["FHEAD"] });
  await queue.enqueue(input("Tail", 2));
  const first = await queue.claim();
  await queue.generationFailed(first, true);
  assert.deepEqual((await state(database, "EvHead")).file_ids, ["FHEAD"]);
  assert.equal(await other.claim(), undefined);
  await database.query("UPDATE slack_jobs SET run_after = now()");
  const retry = await other.claim();
  assert.deepEqual(retry.fileIds, ["FHEAD"]);
  await other.generationFailed(retry, false);
  const terminal = await state(database, "EvHead");
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.file_ids, null);
  assert.equal((await other.claim()).eventId, "EvTail");
});

test("an expired pending job does not block a fresh job in the same thread", async (t) => {
  const { queue, other, database } = await setup(t);
  await queue.enqueue(input("Expired", 1));
  await queue.enqueue(input("Fresh", 2));
  await database.query("UPDATE slack_jobs SET created_at = now() - interval '25 hours' WHERE event_id = 'EvExpired'");
  assert.equal((await other.claim())?.eventId, "EvFresh");
  assert.equal((await state(database, "EvExpired")).status, "pending");
});

test("expired generation resumes on restart and the previous worker cannot send", async (t) => {
  const { queue, other, database } = await setup(t);
  await queue.enqueue({ ...input("Restart", 1), fileIds: ["FRESTART"] });
  const crashed = await queue.claim();
  await database.query("UPDATE slack_jobs SET lease_until = now() - interval '1 second'");
  await other.recover();
  const resumed = await other.claim();
  assert.deepEqual(resumed.fileIds, ["FRESTART"]);
  assert.notEqual(crashed.attemptId, resumed.attemptId);
  assert.equal(await queue.reserveSend(crashed, "stale"), false);
  await queue.generationFailed(crashed, true);
  assert(await other.reserveSend(resumed, "fresh"));
  assert.equal((await state(database, "EvRestart")).file_ids, null);
  await other.finishSend(resumed, sent, "fresh");
  const row = await state(database, "EvRestart");
  assert.equal(row.status, "delivered");
  assert.equal(row.generation_attempts, 2);
  assert.equal(row.input_text, null);
  assert.equal(row.user_id, null);
  assert.equal(row.reply_text, null);
});

test("a crash in the sending phase quarantines the attempt", async (t) => {
  const { queue, other, database } = await setup(t);
  await queue.enqueue(input("Sending", 1));
  const active = await queue.claim();
  assert(await queue.reserveSend(active, "reply"));
  await database.query("UPDATE slack_jobs SET lease_until = now() - interval '1 second'");
  await other.recover();
  const row = await state(database, "EvSending");
  assert.equal(row.status, "uncertain");
  assert.equal(row.last_error, "slack_send_interrupted");
  assert.equal(row.input_text, null);
  assert.equal(row.reply_text, null);
  assert.equal(await other.claim(), undefined);
});

test("Slack 429 holds new sends and retries the saved reply without regenerating it", async (t) => {
  const { queue, other, database } = await setup(t);
  await queue.enqueue({ ...input("Limited", 1), fileIds: ["FLIMITED"] });
  await other.enqueue({ ...input("Parallel", 2, "COTHER"), fileIds: ["FPARALLEL"] });
  const limited = await queue.claim();
  const parallel = await other.claim();
  let generations = 0;
  let downloads = 0;
  const agent = async () => { generations++; return "generated"; };
  const loadFiles = async (message, ids) => {
    downloads++;
    assert.equal(message.channelId, limited.channelId);
    assert.equal(message.messageTs, limited.messageTs);
    assert.deepEqual(ids, ["FLIMITED"]);
    return [{ name: "sample.txt", mimeType: "text/plain", bytes: Buffer.from("sample") }];
  };
  await processJob(queue, limited, agent, async () => ({ kind: "rate_limited", retryAfterSeconds: 60 }),
    loadFiles);
  const before = Date.now();
  const row = await state(database, "EvLimited");
  assert.equal(row.status, "pending");
  assert.equal(row.reply_text, "generated");
  assert.equal(row.input_text, null);
  assert.equal(row.user_id, null);
  assert.equal(row.file_ids, null);
  assert(row.run_after.getTime() > before + 55_000);
  assert.equal(await other.reserveSend(parallel, "parallel reply"), false);
  const deferred = await state(database, "EvParallel");
  assert.equal(deferred.send_attempts, 0);
  assert.equal(deferred.input_text, null);
  assert.equal(deferred.user_id, null);
  assert.equal(deferred.file_ids, null);
  assert.equal(await other.claim(), undefined);
  await database.query("UPDATE agent_runtime SET slack_blocked_until = '-infinity'");
  await database.query("UPDATE slack_jobs SET run_after = now()");
  const retry = await other.claim();
  assert.equal(retry.eventId, "EvLimited");
  await processJob(other, retry, agent, async (_job, reply) => {
    assert.equal(reply, "generated");
    return sent;
  }, loadFiles);
  assert.equal(generations, 1);
  assert.equal(downloads, 1);
  assert.equal((await state(database, "EvLimited")).status, "delivered");
});

test("a late confirmed 429 recovers an uncertain send for the exact attempt", async (t) => {
  const { queue, other, database } = await setup(t);
  await queue.enqueue({ ...input("LateLimit", 1), fileIds: ["FLATE"] });
  const active = await queue.claim();
  assert(await queue.reserveSend(active, "saved reply"));
  await database.query("UPDATE slack_jobs SET lease_until = now() - interval '1 second'");
  await other.recover();
  assert.equal((await state(database, "EvLateLimit")).status, "uncertain");
  const rateLimit = { kind: "rate_limited", retryAfterSeconds: 30 };
  await queue.finishSend({ ...active, attemptId: randomUUID() }, rateLimit, "wrong attempt");
  assert.equal((await state(database, "EvLateLimit")).status, "uncertain");
  const readCooldown = async () =>
    (await database.query("SELECT slack_blocked_until::text AS deadline FROM agent_runtime")).rows[0].deadline;
  assert.equal(await readCooldown(), "-infinity");
  await queue.finishSend(active, rateLimit, "saved reply");
  const retried = await state(database, "EvLateLimit");
  assert.equal(retried.status, "pending");
  assert.equal(retried.reply_text, "saved reply");
  assert.equal(retried.finished_at, null);
  assert.equal(retried.input_text, null);
  assert.equal(retried.user_id, null);
  assert.equal(retried.file_ids, null);
  const deadline = await readCooldown();
  await queue.finishSend(active, rateLimit, "duplicate receipt");
  assert.equal(await readCooldown(), deadline);
  assert.equal((await state(database, "EvLateLimit")).reply_text, "saved reply");
  assert.equal(await other.claim(), undefined);
  await database.query("UPDATE agent_runtime SET slack_blocked_until = '-infinity'");
  await database.query("UPDATE slack_jobs SET run_after = now()");
  const replay = await other.claim();
  assert.deepEqual(replay.fileIds, []);
  await processJob(other, replay, async () => assert.fail("the saved reply must not be regenerated"),
    async (_job, reply) => { assert.equal(reply, "saved reply"); return sent; },
    async () => assert.fail("the saved reply must not fetch files again"));
});

test("recovery and cleanup skip locked rows without blocking unrelated work", async (t) => {
  const { queue, other, database } = await setup(t);
  await queue.enqueue(input("LockedWork", 1, "CLOCKED"));
  await queue.enqueue(input("FreeWork", 2, "CFREE"));
  await queue.claim();
  await queue.claim();
  await database.query("UPDATE slack_jobs SET lease_until = now() - interval '1 second'");
  await queue.enqueue(input("LockedHistory", 3, "CLOCKED"));
  await queue.enqueue(input("FreeHistory", 4, "CFREE"));
  await database.query(`UPDATE slack_jobs SET status = 'delivered',
    finished_at = now() - interval '8 days' WHERE event_id IN ('EvLockedHistory', 'EvFreeHistory')`);
  const lock = await database.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT 1 FROM slack_jobs WHERE event_id IN ('EvLockedHistory', 'EvLockedWork') FOR UPDATE");
    await other.recover();
    await other.prune();
    assert.equal((await state(database, "EvLockedWork")).status, "working");
    assert.equal((await state(database, "EvFreeWork")).status, "pending");
    assert(await state(database, "EvLockedHistory"));
    assert.equal(await state(database, "EvFreeHistory"), undefined);
    assert.equal((await other.claim())?.eventId, "EvFreeWork");
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
  await other.recover();
  await other.prune();
  assert.equal((await state(database, "EvLockedWork")).status, "pending");
  assert.equal(await state(database, "EvLockedHistory"), undefined);
});

test("the running worker processes a persisted job and stops gracefully", async (t) => {
  const { queue, database } = await setup(t);
  const worker = startWorker(queue, 2, async () => "demo reply", async () => sent);
  try {
    await queue.enqueue(input("Worker", 1));
    worker.wake();
    const deadline = Date.now() + 5000;
    while ((await state(database, "EvWorker")).status !== "delivered") {
      assert(Date.now() < deadline, "worker did not deliver");
      await sleep(25);
    }
  } finally {
    await worker.stop();
  }
});

test("expires old pending work and removes old delivery metadata", async (t) => {
  const { queue, database } = await setup(t);
  await queue.enqueue({ ...input("OldPending", 1), fileIds: ["FOLD"] });
  await queue.enqueue(input("OldDelivered", 2, "COTHER"));
  await database.query("UPDATE slack_jobs SET created_at = now() - interval '25 hours'");
  await database.query(`UPDATE slack_jobs SET status = 'delivered',
    finished_at = now() - interval '8 days' WHERE event_id = 'EvOldDelivered'`);
  await queue.prune();
  const expired = await state(database, "EvOldPending");
  assert.equal(expired.status, "failed");
  assert.equal(expired.last_error, "queue_expired");
  assert.equal(expired.input_text, null);
  assert.equal(expired.file_ids, null);
  assert.equal(await state(database, "EvOldDelivered"), undefined);
});
