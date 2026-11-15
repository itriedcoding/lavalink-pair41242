/**
 * One Discord gateway connection per tenant bot. Credentials and the last
 * presence come from the Convex deployment through the secret-gated
 * `/worker/bots` route, so a workspace only saves its bot token in the
 * dashboard.
 */

import type { WorkerConfig } from "./config.ts";
import { fetchBots, type BotCredentials } from "./convexApi.ts";
import { DiscordGateway, type PresenceStatus } from "./discord.ts";
import { WorkerError, messageOf } from "./errors.ts";

const REFRESH_MS = 5 * 60_000;

export class BotConnection {
  private readonly gateway: DiscordGateway;
  private presence: { status: PresenceStatus; text: string | null };
  private starting: Promise<void> | null = null;

  constructor(
    readonly botId: string,
    readonly token: string,
    presence: { status: PresenceStatus; text: string | null },
    private readonly log: (...args: unknown[]) => void,
  ) {
    this.presence = presence;
    this.gateway = new DiscordGateway(token, {
      onReady: () => this.applyPresence(),
      onFatal: (reason) => this.log(`bot ${botId}: ${reason}`),
    });
  }

  start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.gateway
        .connect()
        .then((user) => {
          this.applyPresence();
          this.log(`gateway ready for bot ${this.botId} (${user.username})`);
        })
        .catch((error) => {
          this.starting = null;
          throw error;
        });
    }
    return this.starting;
  }

  async setPresence(status: PresenceStatus, text: string | null): Promise<void> {
    this.presence = { status, text };

    // A freshly started worker may still be identifying; wait for READY so the
    // update is not dropped on a socket that is not open yet.
    if (!this.gateway.connected) {
      await this.start();
    }
    this.applyPresence();
  }

  destroy(): void {
    this.gateway.destroy();
  }

  private applyPresence(): void {
    if (!this.gateway.connected) return;
    this.gateway.setPresence(this.presence.status, this.presence.text);
  }
}

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
      throw new WorkerError(
        "This server's bot is not connected to the presence worker. Save the bot token in the dashboard first.",
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
      {
        status: bot.presenceStatus,
        text: bot.presenceText,
      },
      this.log,
    );

    this.byBotId.set(bot.botId, connection);
    this.byGuild.set(bot.guildId, connection);

    connection.start().catch((error) => {
      this.log(`bot ${bot.botId} could not connect:`, messageOf(error));
    });
  }
}
