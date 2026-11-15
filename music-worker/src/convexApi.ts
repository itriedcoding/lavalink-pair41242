import type { WorkerConfig } from "./config.ts";

export type BotCredentials = {
  guildId: string;
  botId: string;
  botToken: string;
};

/**
 * The worker authenticates with the same `MUSIC_SHARED_SECRET` that Convex
 * checks, so bot tokens never travel to a browser.
 */
export async function fetchBots(config: WorkerConfig): Promise<BotCredentials[]> {
  const response = await fetch(`${config.convexSiteUrl}/music/bots`, {
    headers: { authorization: `Bearer ${config.sharedSecret}` },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Convex /music/bots returned ${response.status}. Make sure MUSIC_SHARED_SECRET is set to the same value in the deployment and the worker. ${detail.slice(
        0,
        200,
      )}`,
    );
  }

  const payload = (await response.json()) as { bots?: BotCredentials[] };
  if (!Array.isArray(payload.bots)) return [];
  return payload.bots.filter(
    (bot) =>
      typeof bot?.guildId === "string" &&
      typeof bot?.botId === "string" &&
      typeof bot?.botToken === "string",
  );
}
