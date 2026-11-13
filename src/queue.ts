import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Delivery, Installation, SlackInput } from "./slack.js";

const workLeaseSeconds = 45;
const sendLeaseSeconds = 30;
const maxGenerationAttempts = 3;
const maxSendAttempts = 5;

export type Job = {
  eventId: string;
  attemptId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  fileIds: readonly string[];
} & (
  | { reply: null; userId: string; text: string }
  | { reply: string; userId: string | null; text: string | null }
);

export class Queue {
  constructor(private readonly database: Pool) {}

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    let discard = false;
    // A checked-out client can also emit a connection error between queries.
    const onError = () => { discard = true; };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // Closing the connection rolls back an unfinished transaction and drops a stalled socket.
      discard = true;
      throw error;
    } finally {
      client.removeListener("error", onError);
      client.release(discard);
    }
  }

  async initialize(schema: string, installation: Installation): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(714391432, 1)");
      await client.query(schema);
      await client.query(
        "INSERT INTO agent_runtime (team_id, app_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [installation.teamId, installation.appId],
      );
      const bound = await client.query(
        "SELECT 1 FROM agent_runtime WHERE team_id = $1 AND app_id = $2",
        [installation.teamId, installation.appId],
      );
      if (bound.rowCount !== 1) throw new Error("database_installation_mismatch");
    });
  }

  async ready(): Promise<void> {
    await this.database.query("SELECT 1 FROM agent_runtime");
  }

  async enqueue(input: SlackInput): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO slack_jobs
        (event_id, channel_id, thread_ts, message_ts, user_id, input_text, file_ids)
        VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [input.eventId, input.channelId, input.threadTs, input.messageTs, input.userId, input.text,
        input.fileIds ?? null],
    );
    return result.rowCount === 1;
  }

  async claim(): Promise<Job | undefined> {
    try {
      const { rows } = await this.database.query<Job>(
        `WITH candidate AS (
          SELECT j.event_id
          FROM slack_jobs j
          WHERE j.status = 'pending' AND j.run_after <= statement_timestamp()
            AND j.created_at >= statement_timestamp() - interval '24 hours'
            AND (j.reply_text IS NOT NULL OR j.generation_attempts < $3)
            AND (SELECT slack_blocked_until FROM agent_runtime) <= statement_timestamp()
            AND NOT EXISTS (
              SELECT 1 FROM slack_jobs ahead
              WHERE ahead.channel_id = j.channel_id AND ahead.thread_ts = j.thread_ts
                AND (ahead.status IN ('working', 'sending') OR
                     (ahead.status = 'pending' AND ahead.message_ts < j.message_ts
                      AND ahead.created_at >= statement_timestamp() - interval '24 hours'))
            )
          ORDER BY j.run_after, j.message_ts, j.event_id
          LIMIT 1 FOR UPDATE OF j SKIP LOCKED
        )
        UPDATE slack_jobs j
        SET status = 'working', attempt_id = $1, lease_until = clock_timestamp() + $2 * interval '1 second',
            generation_attempts = j.generation_attempts + CASE WHEN j.reply_text IS NULL THEN 1 ELSE 0 END
        FROM candidate WHERE j.event_id = candidate.event_id
        RETURNING j.event_id AS "eventId", j.attempt_id AS "attemptId",
                  j.channel_id AS "channelId", j.thread_ts::text AS "threadTs",
                  j.message_ts::text AS "messageTs", j.user_id AS "userId",
                  j.input_text AS text, j.reply_text AS reply,
                  COALESCE(j.file_ids, ARRAY[]::text[]) AS "fileIds"`,
        [randomUUID(), workLeaseSeconds, maxGenerationAttempts],
      );
      return rows[0];
    } catch (error) {
      // An older event can arrive between two workers' statement snapshots.
      const conflict = error as { code?: string; constraint?: string };
      if (conflict.code === "23505" && conflict.constraint === "slack_jobs_active_thread") {
        return undefined;
      }
      throw error;
    }
  }

  async generationFailed(job: Job, retry: boolean): Promise<void> {
    await this.database.query(
      `UPDATE slack_jobs
        SET status = CASE WHEN $3 AND generation_attempts < $4 THEN 'pending' ELSE 'failed' END,
            run_after = clock_timestamp() + generation_attempts * interval '2 seconds',
            last_error = 'generation_failed', attempt_id = NULL, lease_until = NULL,
            finished_at = CASE WHEN $3 AND generation_attempts < $4 THEN NULL ELSE clock_timestamp() END,
            input_text = CASE WHEN $3 AND generation_attempts < $4 THEN input_text END,
            user_id = CASE WHEN $3 AND generation_attempts < $4 THEN user_id END,
            file_ids = CASE WHEN $3 AND generation_attempts < $4 THEN file_ids END
        WHERE event_id = $1 AND attempt_id = $2 AND status = 'working'
          AND lease_until > clock_timestamp()`,
      [job.eventId, job.attemptId, retry, maxGenerationAttempts],
    );
  }

  async reserveSend(job: Job, reply: string): Promise<boolean> {
    // A workspace cooldown and the send checkpoint must be observed in one transaction.
    return this.transaction(async (client) => {
      await client.query("SELECT 1 FROM agent_runtime FOR UPDATE");
      const result = await client.query<{ status: string }>(
        `UPDATE slack_jobs SET reply_text = $3, file_ids = NULL,
             status = CASE WHEN r.slack_blocked_until > r.checked_at THEN 'pending' ELSE 'sending' END,
             run_after = GREATEST(run_after, r.slack_blocked_until),
             attempt_id = CASE WHEN r.slack_blocked_until <= r.checked_at THEN attempt_id END,
             lease_until = CASE WHEN r.slack_blocked_until <= r.checked_at
               THEN clock_timestamp() + $4 * interval '1 second' END,
             send_attempts = send_attempts + CASE WHEN r.slack_blocked_until <= r.checked_at THEN 1 ELSE 0 END
           FROM (SELECT slack_blocked_until, clock_timestamp() AS checked_at FROM agent_runtime) r
           WHERE event_id = $1 AND attempt_id = $2 AND status = 'working'
             AND lease_until > clock_timestamp()
           RETURNING status`,
        [job.eventId, job.attemptId, reply, sendLeaseSeconds],
      );
      return result.rows[0]?.status === "sending";
    });
  }

  async finishSend(job: Job, delivery: Delivery, reply: string): Promise<void> {
    if (delivery.kind === "rate_limited") {
      await this.database.query(
        `WITH throttle AS MATERIALIZED (
          SELECT GREATEST(
            slack_blocked_until, clock_timestamp() + $3 * interval '1 second'
          ) AS deadline FROM agent_runtime FOR UPDATE
        ), receipt AS (
          UPDATE slack_jobs SET status = CASE WHEN send_attempts < $4 THEN 'pending' ELSE 'failed' END,
            run_after = GREATEST(run_after, throttle.deadline),
            attempt_id = NULL, lease_until = NULL, last_error = 'slack_rate_limited',
            finished_at = CASE WHEN send_attempts >= $4 THEN clock_timestamp() END,
            input_text = CASE WHEN send_attempts < $4 THEN input_text END,
            user_id = CASE WHEN send_attempts < $4 THEN user_id END,
            reply_text = CASE WHEN send_attempts < $4 THEN $5 END, file_ids = NULL
          FROM throttle WHERE event_id = $1 AND attempt_id = $2
            AND status IN ('sending', 'uncertain')
          RETURNING throttle.deadline
        )
        UPDATE agent_runtime SET slack_blocked_until = receipt.deadline FROM receipt`,
        [job.eventId, job.attemptId, delivery.retryAfterSeconds, maxSendAttempts, reply],
      );
      return;
    }
    await this.database.query(
      `UPDATE slack_jobs SET status = $3, slack_ts = $4, last_error = $5,
         finished_at = clock_timestamp(), lease_until = NULL,
         input_text = NULL, user_id = NULL, reply_text = NULL, file_ids = NULL
       WHERE event_id = $1 AND attempt_id = $2 AND status IN ('sending', 'uncertain')`,
      [
        job.eventId, job.attemptId, delivery.kind,
        delivery.kind === "delivered" ? delivery.timestamp : null,
        delivery.kind === "delivered" ? null : delivery.code,
      ],
    );
  }

  async recover(): Promise<void> {
    await this.database.query(
      `UPDATE slack_jobs
       SET status = CASE WHEN status = 'sending' THEN 'uncertain'
                         WHEN reply_text IS NOT NULL OR generation_attempts < $1 THEN 'pending'
                         ELSE 'failed' END,
           last_error = CASE WHEN status = 'sending' THEN 'slack_send_interrupted' ELSE 'generation_interrupted' END,
           attempt_id = CASE WHEN status = 'sending' THEN attempt_id END, lease_until = NULL,
           run_after = clock_timestamp(),
           finished_at = CASE WHEN status = 'sending' OR (reply_text IS NULL AND generation_attempts >= $1)
                              THEN clock_timestamp() END,
           input_text = CASE WHEN status = 'working' AND (reply_text IS NOT NULL OR generation_attempts < $1)
                             THEN input_text END,
           user_id = CASE WHEN status = 'working' AND (reply_text IS NOT NULL OR generation_attempts < $1)
                          THEN user_id END,
           reply_text = CASE WHEN status = 'working' THEN reply_text END,
           file_ids = CASE WHEN status = 'working' AND reply_text IS NULL AND generation_attempts < $1
                           THEN file_ids END
       WHERE event_id IN (
         SELECT event_id FROM slack_jobs
         WHERE status IN ('working', 'sending') AND lease_until <= statement_timestamp()
         ORDER BY lease_until LIMIT 1000 FOR UPDATE SKIP LOCKED
       )`,
      [maxGenerationAttempts],
    );
  }

  async prune(): Promise<void> {
    await this.database.query(
      `DELETE FROM slack_jobs WHERE event_id IN (
         SELECT event_id FROM slack_jobs
         WHERE finished_at < statement_timestamp() - interval '7 days'
         ORDER BY finished_at LIMIT 1000 FOR UPDATE SKIP LOCKED
       )`,
    );
    await this.database.query(
      `UPDATE slack_jobs SET status = 'failed', last_error = 'queue_expired',
          finished_at = clock_timestamp(), input_text = NULL, user_id = NULL, reply_text = NULL,
          file_ids = NULL
        WHERE status = 'pending' AND event_id IN (
          SELECT event_id FROM slack_jobs
          WHERE status = 'pending' AND created_at < statement_timestamp() - interval '24 hours'
          ORDER BY created_at LIMIT 1000
          FOR UPDATE SKIP LOCKED
        )`,
    );
  }
}
