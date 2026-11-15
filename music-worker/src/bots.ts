/**
 * Keeps one Discord gateway connection per tenant bot. Bot credentials come
 * from the Convex deployment through the secret-gated `/music/bots` route, so a
 * workspace only has to save its bot token in the dashboard.
 */

import type { WorkerConfig } from "./config.ts";
import { fetchBots, type BotCredentials } from "./convexApi.ts";
import { MusicError, messageOf } from "./errors.ts";
import { BotConnection } from "./player.ts";

const REFRESH_MS = 5 * 60_000;

export class BotPool {
  private readonly byBotId = new Map<string, BotConnection>();
  private readonly byGuild = new Map<string, BotConnection>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: WorkerConfig,
    private readonly log: (...args: unknown[]) => void,
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch((error) => this.log("bot refresh failed:", messageOf(error)));
    }, REFRESH_MS);
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const connection of this.byBotId.values()) connection.destroy();
    this.byBotId.clear();
    this.byGuild.clear();
  }

  get size(): number {
    return this.byBotId.size;
  }

  async ensureGuild(guildId: string): Promise<BotConnection> {
    const existing = this.byGuild.get(guildId);
    if (existing) return existing;

    await this.refresh();
    const found = this.byGuild.get(guildId);
    if (!found) {
      throw new MusicError(
        "This server's bot is not connected to the music worker. Save the bot token in the dashboard first.",
      );
    }
    return found;
  }

  find(guildId: string): BotConnection | null {
    return this.byGuild.get(guildId) ?? null;
  }

  async refresh(): Promise<void> {
    const bots = await fetchBots(this.config);
    const seen = new Set<string>();

    for (const bot of bots) {
      seen.add(bot.botId);
      const existing = this.byBotId.get(bot.botId);

      if (existing && existing.token === bot.botToken) {
        this.byGuild.set(bot.guildId, existing);
        continue;
      }
      if (existing) {
        existing.destroy();
        this.byBotId.delete(bot.botId);
        for (const [guildId, connection] of this.byGuild) {
          if (connection === existing) this.byGuild.delete(guildId);
        }
      }

      this.spawn(bot);
    }

    for (const [botId, connection] of this.byBotId) {
      if (seen.has(botId)) continue;
      connection.destroy();
      this.byBotId.delete(botId);
      for (const [guildId, value] of this.byGuild) {
        if (value === connection) this.byGuild.delete(guildId);
      }
    }
  }

  private spawn(bot: BotCredentials): void {
    const connection = new BotConnection(
      bot.botId,
      bot.botToken,
      this.config.nodeName,
      this.config.lavalinkUrl,
      this.config.lavalinkPassword,
      this.log,
    );

    this.byBotId.set(bot.botId, connection);
    this.byGuild.set(bot.guildId, connection);

    connection.start().catch((error) => {
      this.log(`bot ${bot.botId} could not connect:`, messageOf(error));
    });
  }
}
