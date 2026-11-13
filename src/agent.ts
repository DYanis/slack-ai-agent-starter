import type { SlackInput } from "./slack.js";
import type { SlackFile } from "./slack-files.js";

export type AgentInput = Omit<SlackInput, "fileIds"> & { files?: readonly SlackFile[] };
export type Agent = (input: Readonly<AgentInput>, signal: AbortSignal) => Promise<string>;

// Replace this function with a call to your model or read-only agent.
export const respond: Agent = async ({ files }) => files?.length
  ? `The Slack agent starter received ${files.length} ${files.length === 1 ? "file" : "files"}. Add your model or agent in src/agent.ts.`
  : "The Slack agent starter is connected. Add your model or agent in src/agent.ts.";
