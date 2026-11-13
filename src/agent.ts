import type { ModelConfig } from "./config.js";
import { asRecord, maxSlackReplyLength } from "./slack.js";
import type { SlackInput } from "./slack.js";
import type { SlackFile } from "./slack-files.js";

export type AgentInput = Omit<SlackInput, "fileIds"> & { files?: readonly SlackFile[] };
export type Agent = (input: Readonly<AgentInput>, signal: AbortSignal) => Promise<string>;

// Demo mode confirms Slack delivery before an owner connects a model.
export const respond: Agent = async ({ files }) => files?.length
  ? `The Slack agent starter received ${files.length} ${files.length === 1 ? "file" : "files"}. Set AI_PROVIDER in the app service variables to connect a model.`
  : "The Slack agent starter is connected. Set AI_PROVIDER in the app service variables to connect a model.";

const maxOutputTokens = 4096;
const unavailableReply = "The AI provider could not answer right now. Please try again later.";

function modelRequest({ provider, model, instructions, apiKey }: ModelConfig, text: string): {
  url: string; headers: Record<string, string>; body: object;
} {
  switch (provider) {
    case "openai":
      return {
        url: "https://api.openai.com/v1/responses",
        headers: { authorization: `Bearer ${apiKey}` },
        body: { model, instructions, input: text, max_output_tokens: maxOutputTokens, store: false },
      };
    case "claude":
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: { authorization: `Bearer ${apiKey}`, "anthropic-version": "2026-10-21" },
        body: { model, system: instructions, messages: [{ role: "user", content: text }], max_tokens: maxOutputTokens },
      };
    case "gemini":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { "x-goog-api-key": apiKey },
        body: {
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: { maxOutputTokens },
        },
      };
  }
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((record) => record !== undefined) : [];
}

function markIncomplete(text: string, limited: boolean): string {
  return limited && text.trim() ? text.trimEnd() + "…" : text;
}

function modelText(provider: ModelConfig["provider"], data: Record<string, unknown> | undefined): string {
  switch (provider) {
    case "openai": {
      const limited = data?.status === "incomplete" &&
        asRecord(data.incomplete_details)?.reason === "max_output_tokens";
      if (data?.status !== "completed" && !limited) return "";
      const text = records(data?.output)
        .filter((item) => item.type === "message" && item.role === "assistant")
        .flatMap((item) => records(item.content))
        .map((part) => {
          if (part.type === "output_text" && typeof part.text === "string") return part.text;
          if (part.type === "refusal" && typeof part.refusal === "string") return part.refusal;
          return "";
        }).join("");
      return markIncomplete(text, limited);
    }
    case "claude": {
      const text = records(data?.content)
        .map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "").join("");
      return markIncomplete(text, data?.stop_reason === "max_tokens" ||
        data?.stop_reason === "model_context_window_exceeded");
    }
    case "gemini": {
      const candidate = Array.isArray(data?.candidates) ? asRecord(data.candidates[0]) : undefined;
      const text = records(asRecord(candidate?.content)?.parts)
        .map((part) => part.thought !== true && typeof part.text === "string" ? part.text : "").join("");
      return markIncomplete(text, candidate?.finishReason === "MAX_TOKENS");
    }
  }
}

async function requestModel(
  config: ModelConfig, text: string, timeoutMs: number, signal: AbortSignal, request: typeof fetch,
): Promise<string> {
  signal.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = AbortSignal.any([signal, timeout]);
  const { url, headers, body } = modelRequest(config, text);
  try {
    const response = await request(url, {
      method: "POST", redirect: "error", signal: requestSignal,
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    requestSignal.throwIfAborted();
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      console.warn(JSON.stringify({ event: "ai_provider_http_error", provider: config.provider, status: response.status }));
      if (response.status === 429) return "The AI provider is limiting requests. Please try again later.";
      if ([400, 401, 403, 404].includes(response.status)) {
        return "The AI provider rejected the request. Ask the app owner to check the model and API key.";
      }
      return unavailableReply;
    }
    const data = asRecord(await response.json());
    requestSignal.throwIfAborted();
    const reply = modelText(config.provider, data).trim();
    if (reply && !reply.includes("\0")) return reply;
    return "The AI provider returned no text. Try rephrasing your message or ask the app owner to check the model.";
  } catch {
    signal.throwIfAborted();
    if (timeout.aborted) {
      console.warn(JSON.stringify({ event: "ai_provider_timeout", provider: config.provider }));
      return "The AI provider took too long to answer. Try again or ask the app owner to choose a faster model.";
    }
    console.warn(JSON.stringify({ event: "ai_provider_request_failed", provider: config.provider }));
    return unavailableReply;
  }
}

export function createAgent(config: ModelConfig | undefined, request: typeof fetch = fetch): Agent {
  if (!config) return respond;
  return async ({ channelId, text, files }, signal) => {
    const message = text.trim();
    const bareAppMention = !channelId.startsWith("D") && /^<@[UW][A-Z0-9]+>$/.test(message);
    if (!message || bareAppMention) {
      return files?.length
        ? "I received your files. Paste the relevant text into a message for me to read it."
        : "What would you like help with?";
    }
    const attachmentNote = files?.length ? "\n\nI did not send the attached files to the model." : "";
    // Leave room within the worker deadline, including the file download budget.
    const timeoutMs = files?.length ? 14_000 : 22_000;
    const reply = await requestModel(config, message, timeoutMs, signal, request);
    signal.throwIfAborted();
    const limit = maxSlackReplyLength - attachmentNote.length;
    if (reply.length <= limit) return reply + attachmentNote;
    return reply.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "") + "…" + attachmentNote;
  };
}
