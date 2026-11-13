# Slack AI Agent Starter

A TypeScript starter for building a Slack AI agent on Railway. It runs one HTTP service and background worker with a private PostgreSQL database. The included agent returns a fixed setup reply so you can verify Slack delivery before connecting a model.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/i64Eez)

## Set up an agent

1. Deploy the Railway template. It creates the app service and a private PostgreSQL service with a persistent data volume. Use a separate deployment and database for each Slack app.
2. Create a Slack app for one workspace. Use [slack-manifest.yaml](slack-manifest.yaml) as a starting point and replace the example URL with your service's public HTTPS URL ending in `/slack/events`. If Slack asks you to verify the URL before the service is configured, create and install the app first with event subscriptions off. Add the two events and verify the URL after the next step.
3. In the Railway app service, set the variables below. Copy the signing secret from **Basic Information** and the bot token from **OAuth & Permissions** after installing the app. Use the IDs of that same Slack app and workspace. Wait for `/health/ready` to return HTTP 200.
4. Turn on **Event Subscriptions** for `app_mention` and `message.im`. Set the Request URL to `https://YOUR-SERVICE/slack/events` and confirm Slack verifies it. Install or reinstall if Slack requests it. Enable the App Home **Messages** tab and allow users to send messages.
5. Invite the bot to a test channel and mention it, or send it a direct message. It should reply in a thread.
6. To add your model, make your own copy of the repository and point your Railway service at that copy. Replace `respond` in [src/agent.ts](src/agent.ts). Return a plain-text reply and pass the provided abort signal to provider calls. The worker may retry generation after a restart. Put any tool that writes to another system behind its own durable idempotency check and approval flow.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Set by the template to the Postgres service's private connection URL. |
| `SLACK_APP_ID` | The Slack app ID shown under Basic Information. |
| `SLACK_TEAM_ID` | The ID of the one allowed workspace. |
| `SLACK_SIGNING_SECRET` | The signing secret for that app. Store it as a Railway secret. |
| `SLACK_BOT_TOKEN` | The installed bot token for that app and workspace. Store it as a Railway secret. |
| `WORKER_CONCURRENCY` | Concurrent work across separate threads. Default 4, range 1 to 8. |
| `PORT` | Railway supplies this port. It defaults to 3000 locally. |

## Run locally

Copy `.env.example` to `.env`, set a random hex database password and fill in the Slack settings. Run `docker compose up --build`. The service is available at `http://localhost:3000`. Slack needs a public HTTPS URL to deliver real events.

Use Node.js 24 to run checks:

```sh
npm ci
npm test
npm run test:integration
```

Set `TEST_DATABASE_URL` to a disposable PostgreSQL database before running integration tests. The suite creates and drops an isolated test schema. CI runs both suites with PostgreSQL.

## Delivery behavior

- Accepts human text mentions in channels the app has joined and text messages in one-to-one DMs. In channels, mention the app again for a follow-up. The sample sends every reply in the original thread and leaves conversation memory to your agent.
- Verifies Slack's signature and request timestamp, and acknowledges an accepted event after the job is in PostgreSQL. Duplicate events and overlapping deliveries for the same message collapse to one job.
- Runs one job per thread at a time. It processes inputs already queued in Slack timestamp order. An older event can arrive after a newer job has started.
- Recovers interrupted generation within a bounded retry budget. On a Slack rate limit, it respects `Retry-After`, pauses further send reservations for the workspace and keeps the generated reply for the next attempt.
- Records the send attempt before calling Slack. If it cannot confirm the outcome, it marks the job `uncertain` for investigation. Check the actual thread before asking anyone to resend. A crash between the checkpoint and the HTTP request can leave an unsent reply in this state.
- Removes message and reply text when a job reaches a final state. The worker retains delivery metadata for seven days for deduplication and troubleshooting. It expires queued work after 24 hours. Database backups have their own retention.

This starter uses the Slack Events API for ordinary Slack apps. Existing Slack-hosted Deno workflows need their own adapter. The example accepts text and ships with zero model credentials or company integrations. It handles Slack transport and queued replies so you can implement agent behavior in one place.

## Reference

- [Slack Events API](https://docs.slack.dev/apis/events-api/)
- [Slack request signatures](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)
- [Railway templates](https://docs.railway.com/templates/deploy)
- [Railway PostgreSQL](https://docs.railway.com/databases/postgresql)
