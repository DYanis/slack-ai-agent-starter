import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isSignedRequest, parseSlackEvent } from "./slack.js";
import type { Installation, SlackInput } from "./slack.js";

const maxBodyBytes = 256 * 1024;
const ackBudgetMs = 2600;

type Options = {
  installation: Installation;
  signingSecret: string;
  enqueue: (input: SlackInput) => Promise<boolean>;
  ready: () => Promise<void>;
  wake: () => void;
};

function send(response: ServerResponse, status: number, body?: object) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, body ? { "content-type": "application/json" } : {});
  response.end(body && JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && Number(declared) > maxBodyBytes) return;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) return;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export function createHttpServer(options: Options) {
  return createServer({
    headersTimeout: 3000,
    requestTimeout: 3000,
    connectionsCheckingInterval: 1000,
    keepAliveTimeout: 5000,
  }, async (request, response) => {
    if (request.method === "GET" && request.url === "/health/live") {
      return send(response, 200, { status: "ok" });
    }
    if (request.method === "GET" && request.url === "/health/ready") {
      try {
        await options.ready();
        return send(response, 200, { status: "ready" });
      } catch {
        return send(response, 503, { status: "unavailable" });
      }
    }
    if (request.method !== "POST" || request.url !== "/slack/events") {
      return send(response, 404);
    }
    const timer = setTimeout(() => {
      if (!response.headersSent) response.setHeader("connection", "close");
      send(response, 503);
    }, ackBudgetMs);
    try {
      const timestamp = request.headers["x-slack-request-timestamp"];
      const signature = request.headers["x-slack-signature"];
      if (typeof timestamp !== "string" || typeof signature !== "string") {
        response.setHeader("connection", "close");
        return send(response, 401);
      }
      const body = await readBody(request);
      if (response.writableEnded || response.destroyed) return;
      if (!body) {
        response.setHeader("connection", "close");
        return send(response, 413);
      }
      if (!isSignedRequest(options.signingSecret, timestamp, signature, body)) {
        return send(response, 401);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        return send(response, 400);
      }
      const event = parseSlackEvent(payload, options.installation);
      if (event.kind === "challenge") return send(response, 200, { challenge: event.challenge });
      if (event.kind === "input") {
        const inserted = await options.enqueue(event.input);
        send(response, 200);
        if (inserted) options.wake();
        return;
      }
      send(response, 200);
    } catch {
      console.error(JSON.stringify({ event: "slack_ingress_unavailable" }));
      send(response, 503);
    } finally {
      clearTimeout(timer);
    }
  });
}
