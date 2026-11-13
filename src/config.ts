const providerKeyVariables = {
  openai: "OPENAI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
} as const;

export type ModelConfig = Readonly<{
  provider: keyof typeof providerKeyVariables;
  model: string;
  instructions: string;
  apiKey: string;
}>;

export function readConfig(env: NodeJS.ProcessEnv) {
  function required(name: string, pattern?: RegExp): string {
    const value = env[name]?.trim();
    if (!value || (pattern && !pattern.test(value))) {
      throw new Error(`Invalid or missing ${name}`);
    }
    return value;
  }

  function integer(name: string, fallback: number, max: number): number {
    const value = env[name] ?? String(fallback);
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) ||
        parsed < 1 || parsed > max) throw new Error(`Invalid ${name}`);
    return parsed;
  }

  function readModelConfig(): ModelConfig | undefined {
    const provider = env.AI_PROVIDER?.trim().toLowerCase();
    if (!provider || provider === "demo") return undefined;
    if (provider !== "openai" && provider !== "claude" && provider !== "gemini") {
      throw new Error("Invalid AI_PROVIDER. Use openai, claude, gemini or demo.");
    }
    const model = provider === "gemini"
      ? required("AI_MODEL", /^(?:models\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/).replace(/^models\//, "")
      : required("AI_MODEL", /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
    return {
      provider,
      model,
      instructions: env.AI_INSTRUCTIONS?.trim() || "You are a helpful Slack assistant. Reply briefly in plain text.",
      apiKey: required(providerKeyVariables[provider], /^[!-~]+$/),
    };
  }

  const databaseUrl = required("DATABASE_URL", /^postgres(?:ql)?:\/\//);
  try {
    const url = new URL(databaseUrl);
    if (!url.hostname && url.pathname.length < 2 && !url.searchParams.size) {
      throw new Error("Missing database target");
    }
  } catch {
    throw new Error("Invalid DATABASE_URL");
  }
  const filesEnabled = env.SLACK_FILES_ENABLED ?? "true";
  if (filesEnabled !== "true" && filesEnabled !== "false") {
    throw new Error("Invalid SLACK_FILES_ENABLED");
  }

  return {
    databaseUrl,
    appId: required("SLACK_APP_ID", /^A[A-Z0-9]+$/),
    teamId: required("SLACK_TEAM_ID", /^T[A-Z0-9]+$/),
    signingSecret: required("SLACK_SIGNING_SECRET", /^[A-Za-z0-9]+$/),
    botToken: required("SLACK_BOT_TOKEN", /^xoxb-[A-Za-z0-9-]+$/),
    model: readModelConfig(),
    filesEnabled: filesEnabled === "true",
    concurrency: integer("WORKER_CONCURRENCY", 4, 8),
    port: integer("PORT", 3000, 65535),
  };
}
