import { setTimeout as sleep } from "node:timers/promises";
import type { Agent } from "./agent.js";
import type { Job, Queue } from "./queue.js";
import type { Delivery } from "./slack.js";

type Deliver = (job: Job, reply: string) => Promise<Delivery>;

export async function processJob(queue: Queue, job: Job, agent: Agent, deliver: Deliver) {
  let reply = job.reply;
  if (reply === null) {
    try {
      const signal = AbortSignal.timeout(25_000);
      // The adapter must pass this signal to its provider request.
      reply = (await agent(job, signal)).trim();
      signal.throwIfAborted();
    } catch {
      await queue.generationFailed(job, true);
      return;
    }
    if (!reply || reply.length > 4000 || reply.includes("\0")) {
      await queue.generationFailed(job, false);
      return;
    }
  }

  const reservationStartedAt = performance.now();
  if (!await queue.reserveSend(job, reply)) return;
  if (performance.now() - reservationStartedAt >= 20_000) {
    await queue.finishSend(job, { kind: "failed", code: "slack_send_reservation_expired" }, reply);
    return;
  }
  const outcome = await deliver(job, reply);
  // A failed receipt write leaves a sending checkpoint for recovery.
  await queue.finishSend(job, outcome, reply);
  if (outcome.kind !== "delivered") {
    console.warn(JSON.stringify({
      event: "delivery_result", event_id: job.eventId, result: outcome.kind,
      ...(outcome.kind === "rate_limited" ? { retry_after_seconds: outcome.retryAfterSeconds } : {}),
    }));
  }
}

export function startWorker(queue: Queue, concurrency: number, agent: Agent, deliver: Deliver) {
  let stopped = false;
  let wakeUp: (() => void) | undefined;
  const running = new Set<Promise<void>>();
  const wake = () => wakeUp?.();
  const loop = async () => {
    let nextRecovery = 0;
    let nextPrune = 0;
    while (!stopped) {
      try {
        if (Date.now() >= nextRecovery) {
          await queue.recover();
          nextRecovery = Date.now() + 5000;
        }
        if (Date.now() >= nextPrune) {
          await queue.prune();
          nextPrune = Date.now() + 60_000;
        }
        while (!stopped && running.size < concurrency) {
          const job = await queue.claim();
          if (!job) break;
          if (stopped) break;
          const task = processJob(queue, job, agent, deliver).catch(() => {
            console.error(JSON.stringify({ event: "worker_job_error", event_id: job.eventId }));
          }).finally(() => {
            running.delete(task);
            wake();
          });
          running.add(task);
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
