export type WorkerConfig = {
  convexSiteUrl: string;
  sharedSecret: string;
  port: number;
};

/**
 * Everything the worker needs, read once at boot. It only talks to Convex and
 * Discord, so there is nothing else to configure.
 */
export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const missing: string[] = [];
  const read = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      missing.push(name);
      return "";
    }
    return value;
  };

  const config: WorkerConfig = {
    convexSiteUrl: read("CONVEX_SITE_URL").replace(/\/+$/, ""),
    sharedSecret: read("WORKER_SHARED_SECRET"),
    port: Number(env.PORT ?? 8099),
  };

  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}. Copy bot-worker/env.example to bot-worker/.env and fill it in.`,
    );
  }

  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }

  return config;
}
