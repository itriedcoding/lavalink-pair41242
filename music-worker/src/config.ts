export type WorkerConfig = {
  convexSiteUrl: string;
  sharedSecret: string;
  lavalinkUrl: string;
  lavalinkPassword: string;
  nodeName: string;
  port: number;
};

/**
 * Public community Lavalink node, used unless the worker is pointed at its own.
 * Its password is published by the operator; self-host for production so a
 * shared node's uptime and rate limits are not on someone else's terms.
 */
const DEFAULT_LAVALINK_URL = "https://lavalink-v4.triniumhost.com:443";
const DEFAULT_LAVALINK_PASSWORD = "free";
const DEFAULT_LAVALINK_NAME = "triniumhost";

/**
 * Everything the worker needs, read once at boot. The worker never talks to
 * Lavalink or Convex with defaults that could silently point somewhere wrong.
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
    sharedSecret: read("MUSIC_SHARED_SECRET"),
    lavalinkUrl: (env.LAVALINK_URL?.trim() || DEFAULT_LAVALINK_URL).replace(/\/+$/, ""),
    lavalinkPassword: env.LAVALINK_PASSWORD?.trim() || DEFAULT_LAVALINK_PASSWORD,
    nodeName: env.LAVALINK_NAME?.trim() || DEFAULT_LAVALINK_NAME,
    port: Number(env.PORT ?? 8099),
  };

  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}. Copy music-worker/.env.example to music-worker/.env and fill it in.`,
    );
  }

  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }

  return config;
}
