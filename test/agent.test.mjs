import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgent } from "../dist/agent.js";
import { readConfig } from "../dist/config.js";

const slackEnv = {
  DATABASE_URL: "postgresql://localhost:5432/agent",
  SLACK_APP_ID: "AEXAMPLE",
  SLACK_TEAM_ID: "TEXAMPLE",
  SLACK_SIGNING_SECRET: "exampleSignSecret",
  SLACK_BOT_TOKEN: "xoxb-example",
};
const keys = {
  OPENAI_API_KEY: "openai-test-key",
  ANTHROPIC_API_KEY: "claude-test-key",
  GEMINI_API_KEY: "gemini-test-key",
};
const instructions = "Answer in Bulgarian.\nUse two short sentences.";
const input = {
  eventId: "EvExample", channelId: "DEXAMPLE", threadTs: "1700000000.000004",
  messageTs: "1700000000.000004", userId: "UEXAMPLE", text: "Give me an example.",
};
const signal = new AbortController().signal;
const openaiReply = (text) => ({
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
});

function configured(provider, model, options = {}) {
  return readConfig({ ...slackEnv, ...keys, AI_PROVIDER: provider, AI_MODEL: model,
    AI_INSTRUCTIONS: instructions, ...options }).model;
}

test("missing, blank, or explicit demo provider preserves the setup reply without an API call", async () => {
  for (const provider of [undefined, "", "  ", "demo"]) {
    const config = readConfig({ ...slackEnv, AI_PROVIDER: provider, AI_MODEL: "", OPENAI_API_KEY: "" });
    const agent = createAgent(config.model, async () => assert.fail("demo called a model"));
    assert.match(await agent(input, signal), /starter is connected/);
  }
});

test("AI startup checks the chosen model and key without exposing values", () => {
  assert.throws(() => configured("unknown-value", "test-model"), {
    message: "Invalid AI_PROVIDER. Use openai, claude, gemini or demo.",
  });
  for (const model of ["", "https://example.com/model", "../model", "models/test/extra"]) {
    assert.throws(() => configured("gemini", model), { message: "Invalid or missing AI_MODEL" });
  }
  for (const key of ["", "  ", "key\r\nx-extra: value"]) {
    assert.throws(() => configured("claude", "test-model", { ANTHROPIC_API_KEY: key }), {
      message: "Invalid or missing ANTHROPIC_API_KEY",
    });
  }
  assert.equal(configured(" Gemini ", "models/test-model", { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" }).model,
    "test-model");
  assert.equal(configured("openai", "ft:test-model:org::id", { GEMINI_API_KEY: "" }).model, "ft:test-model:org::id");
  assert.equal(configured("openai", "test-model", { AI_INSTRUCTIONS: "" }).instructions,
    "You are a helpful Slack assistant. Reply briefly in plain text.");
});

const providerCases = [
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    url: "https://api.openai.com/v1/responses",
    headers: { authorization: "Bearer openai-test-key" },
    body: { model: "gpt-4.1-mini", instructions, input: input.text, max_output_tokens: 4096, store: false },
    response: {
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ text: "not for Slack" }] },
        { type: "message", role: "assistant", content: [
          { type: "output_text", text: "Hello" }, { type: "output_text", text: "!" },
        ] },
      ],
    },
  },
  {
    provider: "claude",
    model: "claude-haiku-4-5",
    url: "https://api.anthropic.com/v1/messages",
    headers: { authorization: "Bearer claude-test-key", "anthropic-version": "2026-10-21" },
    body: { model: "claude-haiku-4-5", system: instructions,
      messages: [{ role: "user", content: input.text }], max_tokens: 4096 },
    response: { content: [{ type: "thinking", thinking: "not for Slack" }, { type: "text", text: "Hello!" }] },
  },
  {
    provider: "gemini",
    model: "models/gemini-3.5-flash-lite",
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    headers: { "x-goog-api-key": "gemini-test-key" },
    body: { systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: "user", parts: [{ text: input.text }] }],
      generationConfig: { maxOutputTokens: 4096 } },
    response: { candidates: [{ content: { parts: [
      { thought: true, text: "not for Slack" }, { text: "Hello!" },
    ] } }, { content: { parts: [{ text: "not the selected candidate" }] } }] },
  },
];

for (const fixture of providerCases) {
  test(fixture.provider + " uses only the configured model and key and returns visible text", async () => {
    let requests = 0;
    const agent = createAgent(configured(fixture.provider, fixture.model), async (url, options) => {
      requests++;
      assert.equal(url, fixture.url);
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      assert(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      assert.deepEqual(options.headers, { ...fixture.headers, "content-type": "application/json" });
      assert.deepEqual(JSON.parse(options.body), fixture.body);
      return Response.json(fixture.response);
    });
    assert.equal(await agent(input, signal), "Hello!");
    assert.equal(requests, 1);
  });
}

test("provider errors give safe replies and perform no immediate retries", async (t) => {
  const log = t.mock.method(console, "warn", () => {});
  const statuses = [[401, /check the model and API key/], [402, /check billing/], [429, /quota and billing/],
    [500, /could not answer/], [307, /could not answer/]];
  for (const [status, message] of statuses) {
    let requests = 0;
    const agent = createAgent(configured("openai", "test-model"), async () => {
      requests++;
      return new Response("private provider error", { status });
    });
    const reply = await agent(input, signal);
    assert.match(reply, message);
    assert.equal(requests, 1);
    assert.doesNotMatch(reply, /private provider error|test-key/);
  }
  const badJson = createAgent(configured("gemini", "test-model"),
    async () => new Response("not valid JSON"));
  assert.match(await badJson(input, signal), /could not answer/);
  const networkFailure = createAgent(configured("openai", "test-model"), async () => {
    throw new Error("sensitive diagnostic");
  });
  assert.match(await networkFailure(input, signal), /could not answer/);
  assert.doesNotMatch(JSON.stringify(log.mock.calls.map(({ arguments: args }) => args)),
    /private provider error|sensitive diagnostic|test-key|Give me an example/);
});

test("handles blocked or empty content, explicit refusal and an output limit", async () => {
  const blocked = [
    ["gemini", { promptFeedback: { blockReason: "SAFETY" } }],
    ...["PROHIBITED_CONTENT", "ESCALATION", "PUP_LIMITED_DISABLED", "IMAGE_RECITATION"].map((finishReason) =>
      ["gemini", { candidates: [{ content: { parts: [{ text: "Partial blocked text" }] }, finishReason }] }]),
    ["claude", { content: [], stop_reason: "refusal", stop_details: { explanation: "Private reason" } }],
    ["claude", { content: [{ type: "text", text: "Partial blocked text" }], stop_reason: "refusal" }],
    ["openai", { ...openaiReply("Partial blocked text"), status: "incomplete",
      incomplete_details: { reason: "content_filter" } }],
  ];
  for (const [provider, reply] of blocked) {
    const agent = createAgent(configured(provider, "test-model"), async () => Response.json(reply));
    assert.equal(await agent(input, signal), "The AI provider declined this request. Try a different question.");
  }
  const empty = createAgent(configured("gemini", "test-model"), async () => Response.json({ candidates: [] }));
  assert.match(await empty(input, signal), /returned no text/);
  const refusal = openaiReply("");
  refusal.output[0].content = [{ type: "refusal", refusal: "I cannot help with that." }];
  assert.equal(await createAgent(configured("openai", "test-model"),
    async () => Response.json(refusal))(input, signal), "I cannot help with that.");
  const limitedReplies = [
    ["openai", { ...openaiReply("Partial response"), status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" } }],
    ["claude", { content: [{ type: "text", text: "Partial response" }], stop_reason: "max_tokens" }],
    ["gemini", { candidates: [{ content: { parts: [{ text: "Partial response" }] }, finishReason: "MAX_TOKENS" }] }],
    ["gemini", { candidates: [{ content: { parts: [{ text: "Partial response" }] }, finishReason: "CONTINUATION" }] }],
  ];
  for (const [provider, reply] of limitedReplies) {
    assert.equal(await createAgent(configured(provider, "test-model"),
      async () => Response.json(reply))(input, signal), "Partial response…");
  }
});

test("the model request uses the worker deadline", async () => {
  const deadline = new AbortController();
  const received = Promise.withResolvers();
  const agent = createAgent(configured("claude", "test-model"), async (_url, options) => {
    received.resolve(options.signal);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  });
  const pending = agent(input, deadline.signal);
  const requestSignal = await received.promise;
  deadline.abort(new Error("test deadline"));
  assert.equal(requestSignal.aborted, true);
  await assert.rejects(pending, /test deadline/);
});

test("a slow model returns a timeout reply before the worker retries the job", async (t) => {
  const timeout = new AbortController();
  const requestStarted = Promise.withResolvers();
  const log = t.mock.method(console, "warn", () => {});
  t.mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 22_000);
    return timeout.signal;
  });
  const agent = createAgent(configured("gemini", "test-model"), async (_url, options) => {
    requestStarted.resolve();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  });
  const reply = agent(input, signal);
  await requestStarted.promise;
  timeout.abort(new Error("private timeout details"));
  assert.match(await reply, /took too long/);
  assert.match(JSON.stringify(log.mock.calls[0].arguments), /ai_provider_timeout/);
  assert.doesNotMatch(JSON.stringify(log.mock.calls[0].arguments), /private timeout details/);
});

const pdfBytes = Buffer.from("%PDF-1.7\nexample");
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x10]);
const textBytes = Buffer.from("Пример\nLine two");
const attachedFiles = [
  { name: "brief", mimeType: "application/pdf", bytes: pdfBytes },
  { name: "chart.png", mimeType: "image/png", bytes: pngBytes },
  { name: "notes.md", mimeType: "text/markdown", bytes: textBytes },
];

for (const fixture of providerCases) {
  test(fixture.provider + " receives the attachment bytes and text in the user message", async () => {
    const caption = "Compare these attachments.";
    const pdfData = pdfBytes.toString("base64");
    const pngData = pngBytes.toString("base64");
    const fileText = "File: notes.md\nПример\nLine two";
    const calls = [];
    const agent = createAgent(configured(fixture.provider, fixture.model), async (url, options) => {
      assert.equal(url, fixture.url);
      assert.deepEqual(options.headers, { ...fixture.headers, "content-type": "application/json" });
      assert.doesNotMatch(options.body, /DEXAMPLE|UEXAMPLE|xoxb-example|files\.slack\.com/);
      calls.push(JSON.parse(options.body));
      return Response.json(fixture.response);
    });
    assert.equal(await agent({ ...input, text: caption, files: attachedFiles }, signal), "Hello!");
    assert.equal(calls.length, 1);
    const expected = { ...fixture.body };
    switch (fixture.provider) {
      case "openai":
        expected.input = [{ role: "user", content: [
          { type: "input_text", text: caption },
          { type: "input_file", filename: "brief.pdf", file_data: "data:application/pdf;base64," + pdfData },
          { type: "input_image", image_url: "data:image/png;base64," + pngData, detail: "auto" },
          { type: "input_text", text: fileText },
        ] }];
        break;
      case "claude":
        expected.messages = [{ role: "user", content: [
          { type: "text", text: caption },
          { type: "document", title: "brief", source: { type: "base64", media_type: "application/pdf", data: pdfData } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: pngData } },
          { type: "text", text: fileText },
        ] }];
        break;
      case "gemini":
        expected.contents = [{ role: "user", parts: [
          { text: caption },
          { inlineData: { mimeType: "application/pdf", data: pdfData } },
          { inlineData: { mimeType: "image/png", data: pngData } },
          { text: fileText },
        ] }];
        break;
    }
    assert.deepEqual(calls[0], expected);
  });
}

test("files without a question are summarized and long replies fit in Slack", async () => {
  const files = [attachedFiles[2]];
  const channelInput = { ...input, channelId: "CEXAMPLE", text: "<@UBOT>" };
  let requests = 0;
  const agent = createAgent(configured("openai", "test-model"), async (_url, options) => {
    requests++;
    const [message] = JSON.parse(options.body).input;
    assert.deepEqual(message.content, [
      { type: "input_text", text: "Summarize the attached files." },
      { type: "input_text", text: "File: notes.md\nПример\nLine two" },
    ]);
    return Response.json(openaiReply("😀".repeat(3000)));
  });
  assert.equal(await agent(channelInput, signal), "What would you like help with?");
  for (const message of [{ ...input, text: "" }, channelInput]) {
    const reply = await agent({ ...message, files }, signal);
    assert(reply.length <= 4000);
    assert.equal(reply.isWellFormed(), true);
    assert.match(reply, /…$/);
  }
  assert.equal(requests, 2);
});

test("a rejected attachment prevents sending any part of the request", async () => {
  const file = { name: "attachment", mimeType: "text/plain", bytes: Buffer.from("safe") };
  const agent = createAgent(configured("openai", "test-model"), async () => {
    assert.fail("the model received a partial attachment set");
  });
  for (const [change, reply] of [
    [{ mimeType: "application/zip" }, /PDF, JPEG, PNG, WebP/],
    [{ bytes: Buffer.alloc(0) }, /empty/],
    [{ bytes: Buffer.from([0xc0, 0xaf]) }, /UTF-8/],
    [{ bytes: Buffer.from("text\0") }, /UTF-8/],
    [{ bytes: Buffer.alloc(64 * 1024, "a") }, /64 KiB/],
    [{ mimeType: "image/png" }, /does not match its file format/],
  ]) {
    assert.match(await agent({ ...input, files: [file, { ...file, ...change }] }, signal), reply);
  }
});

test("Claude accepts an image at its encoded size limit and rejects a larger image", async () => {
  const bytes = Buffer.alloc(7_500_001);
  bytes.set(pngBytes);
  const file = { name: "chart.png", mimeType: "image/png", bytes };
  let requests = 0;
  const agent = createAgent(configured("claude", "test-model"), async (_url, options) => {
    requests++;
    assert.equal(JSON.parse(options.body).messages[0].content[1].source.data.length, 10_000_000);
    return Response.json({ content: [{ type: "text", text: "Image accepted" }] });
  });
  assert.match(await agent({ ...input, files: [file] }, signal), /too large for Claude/);
  const atLimit = { ...file, bytes: bytes.subarray(0, 7_500_000) };
  assert.equal(await agent({ ...input, files: [atLimit] }, signal), "Image accepted");
  assert.equal(requests, 1);
});

test("a Slack user mention on its own is valid input in a direct message", async () => {
  const agent = createAgent(configured("openai", "test-model"), async (_url, options) => {
    assert.equal(JSON.parse(options.body).input, "<@UALICE>");
    return Response.json(openaiReply("I see the user reference."));
  });
  assert.equal(await agent({ ...input, text: "<@UALICE>" }, signal), "I see the user reference.");
});
