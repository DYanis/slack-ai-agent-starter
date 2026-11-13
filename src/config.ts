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

  const databaseUrl = required("DATABASE_URL", /^postgres(?:ql)?:\/\//);
  try {
    new URL(databaseUrl);
  } catch {
    throw new Error("Invalid DATABASE_URL");
  }

  return {
    databaseUrl,
    appId: required("SLACK_APP_ID", /^A[A-Z0-9]+$/),
    teamId: required("SLACK_TEAM_ID", /^T[A-Z0-9]+$/),
    signingSecret: required("SLACK_SIGNING_SECRET", /^[A-Za-z0-9]+$/),
    botToken: required("SLACK_BOT_TOKEN", /^xoxb-[A-Za-z0-9-]+$/),
    concurrency: integer("WORKER_CONCURRENCY", 4, 8),
    port: integer("PORT", 3000, 65535),
  };
}
