# Slack AI Agents Starter

Run your own Slack AI agent on Railway with OpenAI, Claude, or Gemini. Set the model, instructions, and API key in Railway. Each deployment serves one Slack app in one workspace and includes a private PostgreSQL database to queue replies.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/slack-ai-agent-starter)

## Set up an agent

You need a Railway account and permission to install an app in your Slack workspace. You can check Slack delivery in demo mode before adding an AI key.

1. Open [Your Apps](https://api.slack.com/apps) and choose **Create New App → From an app manifest**. Select your workspace, paste [slack-manifest.yaml](slack-manifest.yaml), and install the app. Grant the optional `files:read` permission if you want the bot to read attachments.
2. In the Slack app's **Basic Information**, copy the **App ID** and **Signing Secret**. In **OAuth & Permissions**, copy the **Bot User OAuth Token**, which begins with `xoxb-`. Find the [workspace ID](https://slack.com/help/articles/221769328-Locate-your-Slack-URL-or-ID) starting with `T` in the address of a channel you open in Slack in your browser. In Slack, open the bot's profile and choose **More → Copy member ID** for `SLACK_BOT_USER_ID`. The member ID starts with `U` or `W`. Copy all five values from the same app installation.
3. Open the Railway template, enter the five Slack values below, and deploy. Leave `AI_PROVIDER` blank for a demo reply. On the app service, copy the HTTPS domain under **Settings → Public Networking**. If you do not see one, choose **Generate Domain** on port `3000`. Wait for `/health/ready` at that domain to return HTTP 200.
4. In the Slack app settings, open **Event Subscriptions** and turn on **Enable Events**. Enter the Railway HTTPS domain followed by `/slack/events` as the **Request URL**. Wait for Slack to verify it. Under **Subscribe to bot events**, add `app_mention` and `message.im`, then save. Reinstall if Slack asks and update the Railway token if it changed.
5. Invite the bot to an ordinary test channel and mention it. Also send the bot a direct message from its **Messages** tab. A demo reply in both threads confirms that Slack can deliver events and the bot can reply. Continue with [Connect an AI model](#connect-an-ai-model).

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Set by the template to the Postgres service's private connection URL. |
| `SLACK_APP_ID` | The Slack app ID shown under Basic Information. |
| `SLACK_TEAM_ID` | The ID of the one allowed workspace. |
| `SLACK_BOT_USER_ID` | The member ID copied from the bot's Slack profile. Startup checks the token against this ID and the workspace ID. |
| `SLACK_SIGNING_SECRET` | The signing secret for that app. Store it as a Railway secret. |
| `SLACK_BOT_TOKEN` | The installed bot token for that app and workspace. Store it as a Railway secret. |
| `SLACK_FILES_ENABLED` | Send supported attachments to the selected AI provider. Defaults to `true`. Set to `false` for text only. |
| `WORKER_CONCURRENCY` | Concurrent work across separate threads. Default 4, range 1 to 8. |
| `PORT` | Defaults to 3000 and matches the template's public HTTP port. |

Use a separate app service and database for each Slack installation. The template sets up the private database connection and the shutdown grace period.

If you update an older deployment, add `SLACK_BOT_USER_ID` to its service variables before deploying v0.4.0.

## Connect an AI model

1. In the Railway project, open the app service and select **Variables**. Set `AI_PROVIDER` and `AI_MODEL`. Use a text model ID available to your account.
2. Add an API key from your own provider account and [seal the variable](https://docs.railway.com/variables#sealed-variables) in Railway. Set `AI_INSTRUCTIONS` to tell the bot how to reply, such as `Answer in Bulgarian and use short paragraphs`. To use a Markdown instruction file, paste its contents into `AI_INSTRUCTIONS` in the service Variables editor. The editor supports multiple lines.
3. Click **Deploy** to apply the variables and send a new Slack message. Leave `AI_PROVIDER` empty or set it to `demo` to use the built-in setup reply. A selected provider requires both its model and its key.

| `AI_PROVIDER` | `AI_MODEL` example | API key variable |
| --- | --- | --- |
| `openai` | `gpt-6-luna` | `OPENAI_API_KEY` |
| `claude` | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` (key scoped to one Claude workspace) |
| `gemini` | `gemini-3.5-flash-lite` | `GEMINI_API_KEY` (use a billing-enabled project for workplace use) |

The selected provider receives the current Slack message text, configured instructions, and supported attachments when file processing is enabled. Add your own conversation history if your agent needs context across replies. The included providers generate plain text without tools. The app gives a model up to 22 seconds to reply, or 14 seconds after downloading an attachment, within the worker's 25-second deadline.

Use a provider account approved for the data people will send. Provider data use and retention follow your account terms. Google requires paid Gemini API service for apps made available to users in the EEA, Switzerland, or the UK. Its unpaid terms restrict sending sensitive, confidential, or personal information. Review the [Gemini API terms](https://aistudio.google.com/docs/terms) before connecting a workspace.

For custom integrations, make your own copy of the repository and use the `Agent` contract in [src/agent.ts](src/agent.ts). Return a plain text reply and pass the provided abort signal to provider calls. The worker may retry generation after a restart. Protect external writes with their own approval and duplicate prevention.

## Accept files

1. Grant the `files:read` bot scope in Slack. If you add it to an installed app, reinstall the app and use the bot token from that installation. Keep the same `app_mention` and `message.im` subscriptions.
2. Keep `SLACK_FILES_ENABLED=true` to send supported attachments to the selected provider. Set it to `false` in the Railway service or local `.env` to turn file processing off. If you are updating an older installation with `false` saved in Railway, set it to `true` to enable files.
3. Attach a file to a message that mentions the bot, or send it in a direct message to the bot. Include a question to guide the reply. If you send only a file, the bot asks the model to summarize it. Demo mode reports the number of files it received.

The worker accepts up to three Slack-hosted uploads or text snippets with a combined size of 8 MiB per message. It checks that Slack still lists each file as shared on that message before downloading it. If Slack cannot confirm the share, upload the file again directly in that thread. The queue holds file IDs until the reply is saved or the job ends. Downloaded bytes stay in memory during processing.

The built-in integrations accept PDF, JPEG, PNG, WebP, and UTF-8 plain text, Markdown, CSV, TSV, and JSON. Text attachments have a combined limit of 64 KiB. Claude images have a 7.5 MB limit per image before encoding. Choose a model that supports images and PDFs if you need those formats. Model limits also apply. For example, Claude Haiku 4.5 accepts up to 100 PDF pages per request. Split larger PDFs and use unencrypted files. The bot asks for a supported set if any attachment is unavailable, too large, or in an unsupported format. Files are included directly in the model request.

A custom agent receives optional `input.files`, each with a name, MIME type, and raw bytes. Treat the file and its metadata as untrusted. An agent that opens archives or sends files to a model needs its own content, extraction, and data handling limits.

## Troubleshoot setup

| Symptom | What to check |
| --- | --- |
| Slack cannot verify the Request URL | Confirm that Railway reports the service ready. Check the public HTTPS domain, the `/slack/events` path, and the signing secret. |
| Slack verifies the URL but the bot is silent | Check the app and workspace IDs and use the bot token from that app's installation. Confirm both bot events are saved and the bot is invited to the channel. Use a local workspace channel or a direct message. |
| The service reports `slack_installation_mismatch` or `slack_bot_token_invalid` | Check the bot member ID, workspace ID, and token. Copy them from the same app installation in the workspace. |
| The service reports `slack_auth_unavailable` | Check that the Railway service can reach `slack.com` and retry the deployment when Slack is available. |
| The service reports `database_installation_mismatch` | Use the original Slack app and workspace IDs with this database. Use a separate database when setting up a different installation. |
| Text works but files do not | Grant `files:read`, reinstall if needed, and check that `SLACK_FILES_ENABLED=true`. Send a fresh supported file with `@bot` or in a direct message. |
| Demo works but the model fails | Check the provider, model access, API key, billing, and outbound network access. Use a model that accepts the input format. |

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
- Drops the original message text, sender ID, and file IDs once the reply is saved. It keeps the reply until delivery finishes and retains delivery metadata for seven days. It expires queued work after 24 hours. Database backups have their own retention.

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
