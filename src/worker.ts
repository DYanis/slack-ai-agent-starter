import { addAbortListener } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import type { Agent, AgentInput } from "./agent.js";
import type { Job, Queue } from "./queue.js";
import { maxSlackReplyLength } from "./slack.js";
import type { Delivery } from "./slack.js";
import type { LoadSlackFiles } from "./slack-files.js";

type Deliver = (job: Job, reply: string) => Promise<Delivery>;
const generationBudgetMs = 25_000;

async function generateReply(
  job: Extract<Job, { reply: null }>, agent: Agent, signal: AbortSignal, loadFiles?: LoadSlackFiles,
): Promise<string> {
  const { eventId, channelId, threadTs, messageTs, userId, text, fileIds } = job;
  const input: AgentInput = { eventId, channelId, threadTs, messageTs, userId, text };
  if (loadFiles && fileIds.length) {
    try {
      input.files = await loadFiles(channelId, fileIds, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message === "slack_files_rate_limited") {
        return "Slack is limiting file downloads right now. Please try again later.";
      }
      if (error instanceof Error && error.message === "slack_files_missing_scope") {
        return "I need permission to read Slack files. Ask the app owner to grant files:read and reinstall the app.";
      }
      return "I couldn't read all the attached files. Upload up to three files directly to this Slack conversation, with a total size of 8 MiB or less. If that still fails, ask the app owner to check file access.";
    }
  } else if (!text.trim()) {
    return "File support is turned off. Send a text message or ask the app owner to enable files.";
  }
  signal.throwIfAborted();
  return agent(input, signal);
}

export async function processJob(
  queue: Queue, job: Job, agent: Agent, deliver: Deliver, loadFiles?: LoadSlackFiles,
) {
  let reply: string;
  if (job.reply === null) {
    const expiresAt = performance.now() + generationBudgetMs;
    const signal = AbortSignal.timeout(generationBudgetMs);
    const deadline = Promise.withResolvers<never>();
    const onAbort = addAbortListener(signal, () => deadline.reject(signal.reason));
    const checkDeadline = () => {
      signal.throwIfAborted();
      // A busy event loop can delay the abort callback past the elapsed deadline.
      if (performance.now() >= expiresAt) throw new Error("generation_deadline_exceeded");
    };
    try {
      const generation = Promise.resolve().then(() => {
        checkDeadline();
        return generateReply(job, agent, signal, loadFiles);
      });
      reply = (await Promise.race([generation, deadline.promise])).trim();
      checkDeadline();
    } catch {
      await queue.generationFailed(job, true);
      return;
    } finally {
      onAbort[Symbol.dispose]();
    }
    if (!reply || reply.length > maxSlackReplyLength || reply.includes("\0")) {
      await queue.generationFailed(job, false);
      return;
    }
  } else {
    reply = job.reply;
  }

  const reservationStartedAt = performance.now();
  if (!await queue.reserveSend(job, reply)) return;
  if (performance.now() - reservationStartedAt >= 20_000) {
    await queue.finishSend(job, { kind: "failed", code: "slack_send_reservation_expired" }, reply);
    return;
  }
  const outcome = await deliver(job, reply);
  try {
    await queue.finishSend(job, outcome, reply);
  } catch {
    // Retry only the database receipt. A second failure leaves the send checkpoint for recovery.
    await sleep(200);
    await queue.finishSend(job, outcome, reply);
  }
  if (outcome.kind !== "delivered") {
    console.warn(JSON.stringify({
      event: "delivery_result", event_id: job.eventId, result: outcome.kind,
      ...(outcome.kind === "rate_limited"
        ? { retry_after_seconds: outcome.retryAfterSeconds }
        : { code: outcome.code }),
    }));
  }
}

export function startWorker(
  queue: Queue, concurrency: number, agent: Agent, deliver: Deliver, loadFiles?: LoadSlackFiles,
) {
  let stopped = false;
  let wakeUp: (() => void) | undefined;
  const running = new Set<Promise<void>>();
  const wake = () => wakeUp?.();
  async function maintain(operation: "recover" | "prune") {
    try {
      await queue[operation]();
    } catch {
      console.error(JSON.stringify({ event: "worker_maintenance_error", operation }));
    }
  }
  const loop = async () => {
    let nextRecovery = 0;
    let nextPrune = 0;
    while (!stopped) {
      try {
        if (performance.now() >= nextRecovery) {
          nextRecovery = performance.now() + 5000;
          await maintain("recover");
        }
        if (!stopped && performance.now() >= nextPrune) {
          nextPrune = performance.now() + 60_000;
          await maintain("prune");
        }
        if (!stopped && running.size < concurrency) {
          const job = await queue.claim();
          if (job) {
            // A claim that succeeded during shutdown still owns its lease.
            const task = processJob(queue, job, agent, deliver, loadFiles).catch(() => {
              console.error(JSON.stringify({ event: "worker_job_error", event_id: job.eventId }));
            }).finally(() => {
              running.delete(task);
              wake();
            });
            running.add(task);
            continue;
          }
        }
      } catch {
        console.error(JSON.stringify({ event: "worker_database_error" }));
        await sleep(1000);
      }
      if (stopped) break;
      // Polling also wakes instances that did not receive this HTTP request.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, 500);
        function finish() {
          clearTimeout(timer);
          wakeUp = undefined;
          resolve();
        }
        wakeUp = finish;
      });
    }
    await Promise.all(running);
  };
  const done = loop();
  return {
    wake,
    async stop() {
      stopped = true;
      wake();
      await done;
    },
  };
}
