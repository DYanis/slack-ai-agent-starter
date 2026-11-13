import type { ModelConfig } from "./config.js";
import { prepareModelFiles } from "./model-files.js";
import type { ModelFile } from "./model-files.js";
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

function modelRequest({ provider, model, instructions, apiKey }: ModelConfig, text: string, files: readonly ModelFile[]): {
  url: string; headers: Record<string, string>; body: object;
} {
  switch (provider) {
    case "openai": {
      const input = files.length ? [{ role: "user", content: [
        { type: "input_text", text },
        ...files.map((file) => {
          if (file.kind === "text") return { type: "input_text", text: file.text };
          if (file.kind === "pdf") return {
            type: "input_file",
            filename: file.name.toLowerCase().endsWith(".pdf") ? file.name : file.name + ".pdf",
            file_data: `data:application/pdf;base64,${file.data}`,
          };
          return { type: "input_image", image_url: `data:${file.mimeType};base64,${file.data}`, detail: "auto" };
        }),
      ] }] : text;
      return {
        url: "https://api.openai.com/v1/responses",
        headers: { authorization: `Bearer ${apiKey}` },
        body: { model, instructions, input, max_output_tokens: maxOutputTokens, store: false },
      };
    }
    case "claude": {
      const content = files.length ? [
        { type: "text", text },
        ...files.map((file) => {
          if (file.kind === "text") return { type: "text", text: file.text };
          if (file.kind === "pdf") return {
            type: "document", title: file.name, source: { type: "base64", media_type: "application/pdf", data: file.data },
          };
          return { type: "image", source: { type: "base64", media_type: file.mimeType, data: file.data } };
        }),
      ] : text;
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: { authorization: `Bearer ${apiKey}`, "anthropic-version": "2026-10-21" },
        body: { model, system: instructions, messages: [{ role: "user", content }], max_tokens: maxOutputTokens },
      };
    }
    case "gemini":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { "x-goog-api-key": apiKey },
        body: {
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [{ role: "user", parts: [
            { text },
            ...files.map((file) => {
              if (file.kind === "text") return { text: file.text };
              const mimeType = file.kind === "pdf" ? "application/pdf" : file.mimeType;
              return { inlineData: { mimeType, data: file.data } };
            }),
          ] }],
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
  config: ModelConfig, text: string, files: readonly ModelFile[], signal: AbortSignal, request: typeof fetch,
): Promise<string> {
  signal.throwIfAborted();
  // Leave room within the worker deadline for Slack file downloads.
  const timeout = AbortSignal.timeout(files.length ? 14_000 : 22_000);
  const requestSignal = AbortSignal.any([signal, timeout]);
  const { url, headers, body } = modelRequest(config, text, files);
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
      if (files.length && (response.status === 400 || response.status === 413)) {
        return "The AI provider rejected this request. Try a smaller attachment or ask the app owner to check the model's file support.";
      }
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
    const prompt = bareAppMention ? "" : message;
    if (!prompt && !files?.length) return "What would you like help with?";
    signal.throwIfAborted();
    const prepared = prepareModelFiles(files ?? [], config.provider);
    if ("message" in prepared) return prepared.message;
    const reply = await requestModel(
      config, prompt || "Summarize the attached files.", prepared.parts, signal, request,
    );
    signal.throwIfAborted();
    if (reply.length <= maxSlackReplyLength) return reply;
    return reply.slice(0, maxSlackReplyLength - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
  };
}
