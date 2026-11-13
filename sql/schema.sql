CREATE TABLE IF NOT EXISTS agent_runtime (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  team_id text NOT NULL,
  app_id text NOT NULL,
  slack_blocked_until timestamptz NOT NULL DEFAULT '-infinity'
);

CREATE TABLE IF NOT EXISTS slack_jobs (
  event_id text PRIMARY KEY,
  channel_id text NOT NULL,
  thread_ts numeric(18,6) NOT NULL,
  message_ts numeric(18,6) NOT NULL,
  user_id text,
  input_text text,
  reply_text text,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'working', 'sending', 'delivered', 'failed', 'uncertain')
  ),
  generation_attempts integer NOT NULL DEFAULT 0,
  send_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  run_after timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_id uuid,
  lease_until timestamptz,
  last_error text,
  slack_ts text,
  finished_at timestamptz,
  UNIQUE (channel_id, message_ts)
);

ALTER TABLE slack_jobs ADD COLUMN IF NOT EXISTS file_ids text[];

CREATE UNIQUE INDEX IF NOT EXISTS slack_jobs_active_thread
  ON slack_jobs (channel_id, thread_ts)
  WHERE status IN ('working', 'sending');
CREATE INDEX IF NOT EXISTS slack_jobs_thread_head
  ON slack_jobs (channel_id, thread_ts, message_ts)
  WHERE status IN ('pending', 'working', 'sending');
CREATE INDEX IF NOT EXISTS slack_jobs_due
  ON slack_jobs (run_after, message_ts)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS slack_jobs_lease
  ON slack_jobs (lease_until)
  WHERE status IN ('working', 'sending');
CREATE INDEX IF NOT EXISTS slack_jobs_retention
  ON slack_jobs (finished_at)
  WHERE finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS slack_jobs_pending_retention
  ON slack_jobs (created_at)
  WHERE status = 'pending';
