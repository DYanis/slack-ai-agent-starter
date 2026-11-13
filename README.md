# Slack AI Agents Starter

A TypeScript starter for building Slack AI agents on Railway. Each deployment runs one Slack app with a private PostgreSQL database. You can use a demo reply to check Slack delivery, then connect OpenAI, Claude, or Gemini using service variables. With a model connected, the app sends supported files attached to direct messages and channel mentions to that provider by default.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/slack-ai-agent-starter)

## Set up an agent

1. Create and install a Slack app for one workspace. Use [slack-manifest.yaml](slack-manifest.yaml) as a starting point. Remove the `event_subscriptions` block before importing it so Slack does not need a Request URL yet. Grant the optional `files:read` permission to handle attachments.
2. Copy the signing secret from **Basic Information** and the bot token from **OAuth & Permissions**. Use the IDs of that same Slack app and workspace.
3. Open the Railway template, fill in the required Slack variables, and deploy. It creates the app service and a private PostgreSQL service with a persistent volume. Use a separate deployment and database for each Slack app. Set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` to `55` on the app service before using it, then wait for `/health/ready` to return HTTP 200.
4. In Slack, turn on **Event Subscriptions** for `app_mention` and `message.im`. Use your Railway public HTTPS URL followed by `/slack/events` as the Request URL and confirm Slack verifies it. Reinstall if Slack requests it. Make sure the App Home **Messages** tab lets users send messages.
5. Invite the bot to a test channel and mention it. Also send it a direct message. It should reply in each thread. If it does not, check that the token is from the same Slack app and workspace, that the app has `chat:write`, and that it joined the test channel. `/health/ready` checks database access.
6. To enable AI replies, configure a provider in the app service. You can do this after the Slack delivery check.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Set by the template to the Postgres service's private connection URL. |
| `SLACK_APP_ID` | The Slack app ID shown under Basic Information. |
| `SLACK_TEAM_ID` | The ID of the one allowed workspace. |
| `SLACK_SIGNING_SECRET` | The signing secret for that app. Store it as a Railway secret. |
| `SLACK_BOT_TOKEN` | The installed bot token for that app and workspace. Store it as a Railway secret. |
| `SLACK_FILES_ENABLED` | Send supported attachments to the selected AI provider. Defaults to `true`. Set to `false` for text only. |
| `WORKER_CONCURRENCY` | Concurrent work across separate threads. Default 4, range 1 to 8. |
| `PORT` | Defaults to 3000 and matches the template's public HTTP port. |

## Connect an AI model

1. In the Railway project, open the app service and select **Variables**. Set `AI_PROVIDER` and `AI_MODEL`. Use a text model ID available to your account.
2. Add the API key for the selected provider and seal the variable in Railway. Set `AI_INSTRUCTIONS` to tell the bot how to reply, such as `Answer in Bulgarian and use short paragraphs`. The default asks for a brief plain text reply. The service Variables editor supports multiple lines.
3. Click **Deploy** to apply the variables and send a new Slack message. Leave `AI_PROVIDER` empty or set it to `demo` to use the built-in setup reply. A selected provider requires both its model and its key.

| `AI_PROVIDER` | `AI_MODEL` example | API key variable |
| --- | --- | --- |
| `openai` | `gpt-6-luna` | `OPENAI_API_KEY` |
| `claude` | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` (key scoped to one Claude workspace) |
| `gemini` | `gemini-3.5-flash-lite` | `GEMINI_API_KEY` |

The selected provider receives the current Slack message text, configured instructions, and supported attachments when file processing is enabled. Add your own conversation history if your agent needs context across replies. The included providers generate plain text without tools. The app gives a model up to 22 seconds to reply, or 14 seconds after downloading an attachment, within the worker's 25-second deadline.

For custom integrations, make your own copy of the repository and use the `Agent` contract in [src/agent.ts](src/agent.ts). Return a plain text reply and pass the provided abort signal to provider calls. The worker may retry generation after a restart. Protect external writes with their own approval and duplicate prevention.

## Accept files

1. Grant the `files:read` bot scope in Slack. If you add it to an installed app, reinstall the app and use the bot token from that installation. Keep the same `app_mention` and `message.im` subscriptions.
2. Keep `SLACK_FILES_ENABLED=true` to send supported attachments to the selected provider. Set it to `false` in the Railway service or local `.env` to turn file processing off. If you are updating an older installation with `false` saved in Railway, set it to `true` to enable files.
3. Attach a file to a message that mentions the bot, or send it in a direct message to the bot. Include a question to guide the reply. If you send only a file, the bot asks the model to summarize it. Demo mode reports the number of files it received.

The worker accepts up to three Slack-hosted uploads or text snippets with a combined size of 8 MiB per message. It checks that each file is still shared in that conversation before downloading it. The queue holds file IDs until the reply is saved or the job ends. Downloaded bytes stay in memory during processing.

The built-in integrations accept PDF, JPEG, PNG, WebP, and UTF-8 plain text, Markdown, CSV, TSV, and JSON. Text attachments have a combined limit of 64 KiB. Claude images have a 7.5 MB limit per image before encoding. Choose a model that supports images and PDFs if you need those formats. The bot asks for a supported set if any attachment is unavailable, too large, or in an unsupported format. Files are included directly in the model request.

A custom agent receives optional `input.files`, each with a name, MIME type, and raw bytes. Treat the file and its metadata as untrusted. An agent that opens archives or sends files to a model needs its own content, extraction, and data handling limits.

## Run locally

Copy `.env.example` to `.env`, set a random hex database password and fill in the Slack settings. Add the AI variables there if you want model replies. Run `docker compose up --build`. The service is available at `http://localhost:3000`. Slack needs a public HTTPS URL to deliver real events.

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
- Recovers interrupted generation within a bounded retry budget. Each generation attempt has a 25-second deadline. On a Slack rate limit, it respects `Retry-After`, pauses further send reservations for the workspace and keeps the generated reply for the next attempt. A confirmed rate limit that arrives after recovery released the thread can requeue the older reply after newer work has started.
- Records the send attempt before calling Slack. If it cannot confirm the outcome, it marks the job `uncertain` for investigation. Check the actual thread before asking anyone to resend. A crash between the checkpoint and the HTTP request can leave an unsent reply in this state.
- Local Compose allows up to 55 seconds for in-progress work to finish. On Railway, set the app's [draining time](https://docs.railway.com/deployments/deployment-teardown#draining-time) to 55 seconds to give it the same window. After a hard stop, the next worker recovers expired claims and does not automatically repeat a send whose outcome is unknown.
- Removes message and reply text when a job reaches a final state. The worker retains delivery metadata for seven days for deduplication and troubleshooting. It expires queued work after 24 hours. Database backups have their own retention.

This starter uses the Slack Events API for ordinary Slack apps. Existing Slack-hosted Deno workflows need their own adapter. It handles Slack transport and queued replies so you can implement agent behavior in one place. Bring your own model credentials and integrations.

## Reference

- [Slack Events API](https://docs.slack.dev/apis/events-api/)
- [Slack request signatures](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)
- [Slack file downloads](https://docs.slack.dev/messaging/working-with-files/#downloading-files)
- [Railway templates](https://docs.railway.com/templates/deploy)
- [Railway PostgreSQL](https://docs.railway.com/databases/postgresql)
- [Railway Variables](https://docs.railway.com/variables)
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Claude Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Claude workspace keys](https://platform.claude.com/docs/en/manage-claude/authentication#select-a-workspace)
- [Gemini GenerateContent API](https://aistudio.google.com/api-reference/generate-content/generate-content)
