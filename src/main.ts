import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { createAgent } from "./agent.js";
import { readConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { Queue } from "./queue.js";
import { postSlackReply, SlackAuthUnavailable, verifySlackBot } from "./slack.js";
import { createSlackFileLoader } from "./slack-files.js";
import { startWorker } from "./worker.js";

async function start() {
  const config = readConfig(process.env);
  for (let attempt = 1; ; attempt++) {
    try {
      await verifySlackBot(config.botToken, config);
      break;
    } catch (error) {
      if (attempt >= 3 || !(error instanceof SlackAuthUnavailable)) throw error;
      const delay = error.retryAfterSeconds === undefined ? 1500 : error.retryAfterSeconds * 1000;
      if (delay > 60_000) throw error;
      await sleep(delay);
    }
  }
  const connection = {
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 1000,
    statement_timeout: 1500,
    query_timeout: 1550,
    idle_in_transaction_session_timeout: 3000,
  };
  // Keep Slack acknowledgment capacity available when all workers are busy.
  const ingressPool = new Pool({ ...connection, max: 4 });
  const workerPool = new Pool({ ...connection, max: config.concurrency + 1 });
  for (const pool of [ingressPool, workerPool]) {
    pool.on("error", () => console.error(JSON.stringify({ event: "database_connection_error" })));
  }
  const ingress = new Queue(ingressPool);
  const queue = new Queue(workerPool);
  try {
    const schema = await readFile(new URL("../sql/schema.sql", import.meta.url), "utf8");
    // The template provisions PostgreSQL alongside the app. Give a fresh database
    // a short startup window while preserving a hard failure for a wrong tenant.
    for (let attempt = 1; ; attempt++) {
      try {
        await ingress.initialize(schema, config);
        break;
      } catch (error) {
        if (attempt >= 12 ||
            (error instanceof Error && error.message === "database_installation_mismatch")) {
          throw error;
        }
        await sleep(2000);
      }
    }
  } catch (error) {
    await Promise.all([ingressPool.end(), workerPool.end()]);
    throw new Error(error instanceof Error && error.message === "database_installation_mismatch"
      ? error.message : "database_initialization_failed");
  }
  const worker = startWorker(queue, config.concurrency, createAgent(config.model),
    (job, reply) => postSlackReply(config.botToken, job, reply),
    config.filesEnabled ? createSlackFileLoader(config.botToken) : undefined);
  const server = createHttpServer({
    installation: { appId: config.appId, teamId: config.teamId, botUserId: config.botUserId },
    signingSecret: config.signingSecret,
    filesEnabled: config.filesEnabled,
    enqueue: (input) => ingress.enqueue(input),
    ready: () => ingress.ready(),
    wake: worker.wake,
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([worker.stop(), closed]);
    await Promise.all([ingressPool.end(), workerPool.end()]);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void shutdown(); });
  }
  server.once("error", () => {
    console.error(JSON.stringify({ event: "http_server_failed" }));
    process.exitCode = 1;
    void shutdown();
  });
  server.listen(config.port, "0.0.0.0", () => {
    console.info(JSON.stringify({ event: "service_started", port: config.port }));
  });
}

start().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "startup_failed");
  process.exitCode = 1;
});
