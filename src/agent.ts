import type { SlackInput } from "./slack.js";

export type Agent = (input: Readonly<SlackInput>, signal: AbortSignal) => Promise<string>;

// Replace this function with a call to your model or read-only agent.
export const respond: Agent = async () =>
  "The Slack agent starter is connected. Add your model or agent in src/agent.ts.";
