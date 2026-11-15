/**
 * Per-guild player: voice handshake bookkeeping, queue, Lavalink track control
 * and the Discord player message.
 *
 * Lavalink plays exactly one track per player, so the queue lives here and
 * advances on TrackEndEvent.
 */

import {
  DiscordGateway,
  DiscordRestError,
  discordRest,
  type VoiceServerEvent,
  type VoiceStateEvent,
} from "./discord.ts";
import { playerPayload, type PlayerSnapshot } from "./embeds.ts";
import { MusicError } from "./errors.ts";
import { LavalinkNode, type LavalinkEvent, type LavalinkTrack } from "./lavalink.ts";

const DEFAULT_VOLUME = 100;
const MAX_VOLUME = 150;
const VOLUME_STEP = 10;
const PLAYLIST_LIMIT = 50;

export type MusicControl = "play" | "pause" | "stop" | "volup" | "voldown";

export type PlayOutcome = {
  status: "playing" | "queued";
  track: {
    title: string;
    author: string;
    uri: string | null;
    duration: number;
    artworkUrl: string | null;
  };
  queueLength: number;
  volume: number;
  voiceChannelId: string;
};

type QueuedTrack = { track: LavalinkTrack; requesterId: string };

type VoiceParams = { token: string; endpoint: string; sessionId: string };

type Handshake = {
  sessionId?: string;
  token?: string;
  endpoint?: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class BotConnection {
  readonly gateway: DiscordGateway;
  readonly lavalink: LavalinkNode;

  private readonly voiceStates = new Map<string, Map<string, string | null>>();
  private readonly botChannels = new Map<string, string | null>();
  private readonly voiceParams = new Map<string, VoiceParams>();
  private readonly handshakes = new Map<string, Handshake>();
  private readonly players = new Map<string, MusicPlayer>();

  constructor(
    readonly botId: string,
    readonly token: string,
    readonly nodeName: string,
    lavalinkUrl: string,
    lavalinkPassword: string,
    private readonly log: (...args: unknown[]) => void,
  ) {
    this.gateway = new DiscordGateway(token, {
      onVoiceState: (event) => this.handleVoiceState(event),
      onVoiceServer: (event) => this.handleVoiceServer(event),
      onFatal: (reason) => this.log(`bot ${botId}: ${reason}`),
    });
    this.lavalink = new LavalinkNode(
      lavalinkUrl,
      lavalinkPassword,
      "roblox-manager-music",
      botId,
      {
        onEvent: (event) => this.handleLavalinkEvent(event),
        onSession: () => this.resyncPlayers(),
      },
    );
  }

  private starting: Promise<void> | null = null;

  start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.gateway
        .connect()
        .then((user) => {
          this.log(`gateway ready for bot ${this.botId} (${user.username})`);
        })
        .catch((error) => {
          this.starting = null;
          throw error;
        });
    }
    return this.starting;
  }

  destroy(): void {
    this.gateway.destroy();
    this.lavalink.destroy();
    for (const player of this.players.values()) player.destroy();
    this.players.clear();
  }

  voiceChannelOf(guildId: string, userId: string): string | null {
    return this.voiceStates.get(guildId)?.get(userId) ?? null;
  }

  voicePayload(guildId: string): VoiceParams | null {
    return this.voiceParams.get(guildId) ?? null;
  }

  /** Drops cached voice credentials so the next join performs a full handshake. */
  clearVoice(guildId: string): void {
    this.voiceParams.delete(guildId);
    this.botChannels.set(guildId, null);
  }

  async connectVoice(guildId: string, channelId: string): Promise<VoiceParams> {
    const handshake = this.startHandshake(guildId);
    this.gateway.joinVoice(guildId, channelId);
    await handshake.promise;
    const params = this.voiceParams.get(guildId);
    if (!params) {
      throw new MusicError("Discord did not return voice credentials. Try again.");
    }
    return params;
  }

  async play(
    guildId: string,
    userId: string,
    textChannelId: string,
    query: string,
  ): Promise<PlayOutcome> {
    await this.awaitReady();
    const channelId = this.voiceChannelOf(guildId, userId);
    if (!channelId) {
      throw new MusicError("Join a voice channel first — I can only play where you are.");
    }
    const player = this.players.get(guildId) ?? new MusicPlayer(this, guildId, textChannelId, this.log);
    this.players.set(guildId, player);
    return player.play({ userId, channelId, textChannelId, query });
  }

  async control(guildId: string, userId: string, action: MusicControl): Promise<void> {
    const player = this.players.get(guildId);
    if (!player) throw new MusicError("Nothing is playing in this server.");
    await player.control(userId, action);
  }

  state(guildId: string): Record<string, unknown> | null {
    return this.players.get(guildId)?.state() ?? null;
  }

  handleVoiceState(event: VoiceStateEvent): void {
    let states = this.voiceStates.get(event.guildId);
    if (!states) {
      states = new Map();
      this.voiceStates.set(event.guildId, states);
    }
    states.set(event.userId, event.channelId);

    if (event.userId !== this.botId) return;

    this.botChannels.set(event.guildId, event.channelId);
    if (event.channelId === null) {
      this.voiceParams.delete(event.guildId);
      this.players.get(event.guildId)?.handleDisconnect();
      return;
    }

    const handshake = this.handshakes.get(event.guildId);
    if (handshake) {
      handshake.sessionId = event.sessionId;
      this.resolveHandshake(event.guildId);
    }
  }

  handleVoiceServer(event: VoiceServerEvent): void {
    const handshake = this.handshakes.get(event.guildId);
    if (!handshake) return;
    handshake.token = event.token;
    handshake.endpoint = event.endpoint;
    this.resolveHandshake(event.guildId);
  }

  handleLavalinkEvent(event: LavalinkEvent): void {
    this.players.get(event.guildId)?.handleEvent(event);
  }

  /** A Lavalink reconnect forgets players, so re-send voice and track state. */
  private resyncPlayers(): void {
    for (const player of this.players.values()) {
      void player.resync().catch(() => undefined);
    }
  }

  private async awaitReady(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new MusicError(
              "The music worker is still connecting to Discord for this bot. Try again in a few seconds.",
            ),
          ),
        12_000,
      );
    });
    try {
      await Promise.race([this.start(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private startHandshake(guildId: string): Handshake {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const timer = setTimeout(() => {
      this.handshakes.delete(guildId);
      reject(
        new MusicError(
          "Discord did not finish joining the voice channel. Give the bot **Connect** and **Speak**, then try again.",
        ),
      );
    }, 15_000);

    const handshake: Handshake = { resolve, reject, timer, promise };
    this.handshakes.set(guildId, handshake);
    return handshake;
  }

  private resolveHandshake(guildId: string): void {
    const handshake = this.handshakes.get(guildId);
    if (!handshake || !handshake.sessionId || !handshake.token || !handshake.endpoint) return;

    clearTimeout(handshake.timer);
    this.handshakes.delete(guildId);
    this.voiceParams.set(guildId, {
      sessionId: handshake.sessionId,
      token: handshake.token,
      endpoint: handshake.endpoint,
    });
    handshake.resolve();
  }
}

class MusicPlayer {
  private queue: QueuedTrack[] = [];
  private current: QueuedTrack | null = null;
  private voiceChannelId: string | null = null;
  private textChannelId: string;
  private messageId: string | null = null;
  private paused = false;
  private volume = DEFAULT_VOLUME;
  private position = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly bot: BotConnection,
    private readonly guildId: string,
    textChannelId: string,
    private readonly log: (...args: unknown[]) => void,
  ) {
    this.textChannelId = textChannelId;
  }

  play(input: {
    userId: string;
    channelId: string;
    textChannelId: string;
    query: string;
  }): Promise<PlayOutcome> {
    return this.serialize(async () => {
      if (this.voiceChannelId && this.voiceChannelId !== input.channelId) {
        if (this.current) {
          throw new MusicError(
            `I'm already playing in <#${this.voiceChannelId}>. Join me there to queue more.`,
          );
        }
        // Nothing is playing, so follow the member to their channel.
        await this.bot.lavalink.destroyPlayer(this.guildId).catch(() => undefined);
        this.bot.clearVoice(this.guildId);
        this.bot.gateway.joinVoice(this.guildId, null);
        this.voiceChannelId = null;
      }

      if (input.textChannelId !== this.textChannelId) {
        await this.deleteMessage();
        this.textChannelId = input.textChannelId;
      }

      if (!this.voiceChannelId) {
        const params = await this.bot.connectVoice(this.guildId, input.channelId);
        this.voiceChannelId = input.channelId;
        await this.bot.lavalink.updatePlayer(this.guildId, {
          voice: params,
          volume: this.volume,
          paused: false,
        });
      }

      let tracks: LavalinkTrack[];
      try {
        tracks = await this.search(input.query);
      } catch (error) {
        // Do not leave the bot parked in a channel when nothing loaded.
        if (!this.current) {
          await this.bot.lavalink.destroyPlayer(this.guildId).catch(() => undefined);
          this.bot.clearVoice(this.guildId);
          this.bot.gateway.joinVoice(this.guildId, null);
          this.voiceChannelId = null;
        }
        throw error;
      }

      const wasIdle = !this.current;
      for (const track of tracks) {
        this.queue.push({ track, requesterId: input.userId });
      }

      if (wasIdle) {
        await this.playNext();
      } else {
        await this.render();
      }

      const first = tracks[0];
      return {
        status: wasIdle ? "playing" : "queued",
        track: {
          title: first.info.title,
          author: first.info.author,
          uri: first.info.uri ?? null,
          duration: first.info.length,
          artworkUrl: first.info.artworkUrl ?? null,
        },
        queueLength: this.queue.length,
        volume: this.volume,
        voiceChannelId: this.voiceChannelId ?? input.channelId,
      };
    });
  }

  control(userId: string, action: MusicControl): Promise<void> {
    return this.serialize(async () => {
      if (!this.voiceChannelId) throw new MusicError("Nothing is playing right now.");

      const memberChannel = this.bot.voiceChannelOf(this.guildId, userId);
      if (memberChannel !== this.voiceChannelId) {
        throw new MusicError("Join the voice channel I'm playing in to use these controls.");
      }

      switch (action) {
        case "play": {
          if (this.paused && this.current) {
            this.paused = false;
            await this.update({ paused: false });
          } else if (!this.current) {
            await this.playNext();
            return;
          }
          break;
        }
        case "pause": {
          if (!this.current || this.paused) return;
          this.paused = true;
          await this.update({ paused: true });
          break;
        }
        case "stop": {
          await this.stop();
          return;
        }
        case "volup": {
          await this.setVolume(this.volume + VOLUME_STEP);
          return;
        }
        case "voldown": {
          await this.setVolume(this.volume - VOLUME_STEP);
          return;
        }
      }

      await this.render();
    });
  }

  handleEvent(event: LavalinkEvent): void {
    if (event.op === "playerUpdate") {
      this.position = event.state.position;
      return;
    }

    if (event.type === "TrackStartEvent") {
      this.position = 0;
      return;
    }

    if (event.type === "TrackExceptionEvent") {
      void this.render(`Track failed: ${event.exception?.message ?? "unknown error"}`).catch(
        () => undefined,
      );
      return;
    }

    if (event.type === "TrackEndEvent") {
      // "replaced" fires when we start the next track ourselves, and
      // "stopped"/"cleanup" when the player is destroyed on purpose.
      if (["replaced", "stopped", "cleanup"].includes(event.reason)) return;
      void this.serialize(async () => {
        this.current = null;
        await this.playNext();
      }).catch((error) => {
        void this.render(`Could not start the next track: ${messageOfSafe(error)}`).catch(
          () => undefined,
        );
      });
    }
  }

  handleDisconnect(): void {
    const wasConnected = this.voiceChannelId !== null;
    this.voiceChannelId = null;
    this.current = null;
    this.queue = [];
    this.paused = false;
    // Deliberate leaves already rendered "Stopped"/"Queue finished".
    if (wasConnected) {
      void this.render("I was disconnected from the voice channel.").catch(() => undefined);
    }
  }

  async resync(): Promise<void> {
    const voice = this.bot.voicePayload(this.guildId);
    if (!voice || !this.voiceChannelId) return;
    await this.bot.lavalink.updatePlayer(this.guildId, {
      ...(this.current
        ? { track: { encoded: this.current.track.encoded }, position: this.position }
        : {}),
      paused: this.paused,
      volume: this.volume,
      voice,
    });
  }

  state(): Record<string, unknown> {
    return {
      guildId: this.guildId,
      current: this.current
        ? {
            title: this.current.track.info.title,
            author: this.current.track.info.author,
            duration: this.current.track.info.length,
          }
        : null,
      paused: this.paused,
      volume: this.volume,
      position: this.position,
      queueLength: this.queue.length,
      voiceChannelId: this.voiceChannelId,
    };
  }

  destroy(): void {
    this.queue = [];
    this.current = null;
  }

  private async search(query: string): Promise<LavalinkTrack[]> {
    const direct = /^https?:\/\//i.test(query);
    const identifiers = direct ? [query] : [`ytsearch:${query}`, `ytmsearch:${query}`];
    let lastError: unknown = null;

    for (const identifier of identifiers) {
      try {
        const result = await this.bot.lavalink.load(identifier);
        if (result.loadType === "track") return [result.data];
        if (result.loadType === "playlist") {
          if (result.data.tracks.length === 0) continue;
          return result.data.tracks.slice(0, PLAYLIST_LIMIT);
        }
        if (result.loadType === "search" && result.data.length > 0) {
          return result.data.slice(0, 1);
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError instanceof MusicError) throw lastError;
    if (lastError) throw new MusicError(messageOfSafe(lastError));
    throw new MusicError(`Lavalink found nothing for \`${query}\`.`);
  }

  private async playNext(): Promise<void> {
    const next = this.queue.shift();
    if (!next) {
      await this.finish();
      return;
    }

    const voice = this.bot.voicePayload(this.guildId);
    if (!voice) {
      this.current = null;
      await this.finish();
      throw new MusicError("Lost the voice connection. Run `/play` again.");
    }

    this.current = next;
    this.paused = false;
    this.position = 0;

    try {
      await this.bot.lavalink.updatePlayer(this.guildId, {
        track: { encoded: next.track.encoded },
        paused: false,
        position: 0,
        volume: this.volume,
        voice,
      });
    } catch (error) {
      this.current = null;
      throw error;
    }

    await this.render();
  }

  private async setVolume(volume: number): Promise<void> {
    this.volume = Math.max(0, Math.min(MAX_VOLUME, volume));
    await this.update({ volume: this.volume });
    await this.render();
  }

  private async stop(): Promise<void> {
    this.queue = [];
    this.current = null;
    this.paused = false;
    this.position = 0;
    this.voiceChannelId = null;

    await this.bot.lavalink.destroyPlayer(this.guildId).catch(() => undefined);
    this.bot.clearVoice(this.guildId);
    this.bot.gateway.joinVoice(this.guildId, null);
    await this.render("Stopped by a member.");
  }

  private async finish(): Promise<void> {
    this.current = null;
    this.paused = false;
    this.position = 0;
    this.voiceChannelId = null;

    await this.bot.lavalink.destroyPlayer(this.guildId).catch(() => undefined);
    this.bot.clearVoice(this.guildId);
    this.bot.gateway.joinVoice(this.guildId, null);
    await this.render("Queue finished.");
  }

  private async update(body: Record<string, unknown>): Promise<void> {
    const voice = this.bot.voicePayload(this.guildId);
    if (!voice) return;
    await this.bot.lavalink.updatePlayer(this.guildId, { ...body, voice });
  }

  private async render(note?: string): Promise<void> {
    const snapshot: PlayerSnapshot = {
      current: this.current
        ? {
            title: this.current.track.info.title,
            author: this.current.track.info.author,
            uri: this.current.track.info.uri ?? null,
            duration: this.current.track.info.length,
            artworkUrl: this.current.track.info.artworkUrl ?? null,
            requesterId: this.current.requesterId,
          }
        : null,
      paused: this.paused,
      volume: this.volume,
      position: this.position,
      queueLength: this.queue.length,
      connected: Boolean(this.voiceChannelId && this.bot.voicePayload(this.guildId)),
      nodeName: this.bot.nodeName,
    };

    const payload = playerPayload(snapshot, note);

    try {
      if (this.messageId) {
        await discordRest(
          this.bot.token,
          "PATCH",
          `/channels/${this.textChannelId}/messages/${this.messageId}`,
          payload,
        );
        return;
      }
      const created = await discordRest<{ id: string }>(
        this.bot.token,
        "POST",
        `/channels/${this.textChannelId}/messages`,
        payload,
      );
      this.messageId = created.id;
    } catch (error) {
      // A deleted player message must not break playback; post a fresh one next
      // time instead of failing the control that triggered the render.
      if (error instanceof DiscordRestError && error.status === 404) {
        this.messageId = null;
        return;
      }
      this.log(`could not render player for ${this.guildId}:`, messageOfSafe(error));
    }
  }

  private async deleteMessage(): Promise<void> {
    if (!this.messageId) return;
    const messageId = this.messageId;
    this.messageId = null;
    await discordRest(
      this.bot.token,
      "DELETE",
      `/channels/${this.textChannelId}/messages/${messageId}`,
    ).catch(() => undefined);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function messageOfSafe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
