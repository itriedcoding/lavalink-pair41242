/**
 * Minimal Discord gateway client.
 *
 * The main bot answers HTTP interactions only, so voice events never reach
 * Convex. This worker keeps one gateway socket per tenant bot, which is what
 * Lavalink needs in order to open the UDP voice connection: the bot must send
 * op 4 and forward VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE to Lavalink.
 *
 * Only GUILDS and GUILD_VOICE_STATES are requested, neither of which is a
 * privileged intent. No message content is read.
 */

import WebSocket from "ws";

export type GatewayUser = {
  id: string;
  username: string;
  global_name?: string | null;
};

export type VoiceStateEvent = {
  guildId: string;
  userId: string;
  sessionId: string;
  channelId: string | null;
};

export type VoiceServerEvent = {
  guildId: string;
  token: string;
  endpoint: string;
};

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const INTENTS = 1 | 128; // GUILDS | GUILD_VOICE_STATES

type GatewayHandlers = {
  onReady?: (user: GatewayUser) => void;
  onVoiceState?: (event: VoiceStateEvent) => void;
  onVoiceServer?: (event: VoiceServerEvent) => void;
  onFatal?: (reason: string) => void;
};

export class DiscordGateway {
  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private acked = true;
  private stopping = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private ready: Promise<GatewayUser>;
  private resolveReady: ((user: GatewayUser) => void) | null = null;

  user: GatewayUser | null = null;

  constructor(
    readonly token: string,
    private readonly handlers: GatewayHandlers = {},
  ) {
    this.ready = new Promise<GatewayUser>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  /** Resolves once Discord sends READY for this bot. */
  connect(): Promise<GatewayUser> {
    this.open(this.gatewayUrl());
    return this.ready;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.user !== null;
  }

  joinVoice(guildId: string, channelId: string | null): void {
    this.send({
      op: 4,
      d: {
        guild_id: guildId,
        channel_id: channelId,
        self_mute: false,
        self_deaf: true,
      },
    });
  }

  destroy(): void {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "worker shutdown");
    this.socket = null;
  }

  private gatewayUrl(): string {
    return this.sessionId && this.resumeUrl
      ? `${this.resumeUrl.replace(/\/+$/, "")}/?v=10&encoding=json`
      : GATEWAY_URL;
  }

  private open(url: string): void {
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on("message", (raw) => {
      try {
        this.onMessage(JSON.parse(raw.toString()) as GatewayPayload);
      } catch {
        // A malformed frame is not worth tearing the connection down for.
      }
    });

    socket.on("close", (code) => {
      this.socket = null;
      this.stopHeartbeat();
      if (this.stopping) return;
      // 4004 = authentication failed; retrying cannot fix a bad token.
      if (code === 4004) {
        this.handlers.onFatal?.("Discord rejected the bot token (4004).");
        return;
      }
      this.scheduleReconnect();
    });

    socket.on("error", () => {
      // `close` runs right after and owns the retry.
    });
  }

  private onMessage(payload: GatewayPayload): void {
    if (typeof payload.s === "number") this.sequence = payload.s;

    switch (payload.op) {
      case 10: {
        const interval = Number(
          (payload.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41_250,
        );
        this.startHeartbeat(interval);
        if (this.sessionId && this.sequence !== null) {
          this.send({
            op: 6,
            d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
          });
        } else {
          this.send({
            op: 2,
            d: {
              token: this.token,
              intents: INTENTS,
              properties: {
                os: process.platform,
                browser: "roblox-manager-music",
                device: "roblox-manager-music",
              },
            },
          });
        }
        return;
      }
      case 11:
        this.acked = true;
        return;
      case 1:
        this.sendHeartbeat();
        return;
      case 7:
        this.reconnectNow();
        return;
      case 9:
        // Invalid session: drop the sequence and identify again from scratch.
        this.sessionId = null;
        this.sequence = null;
        setTimeout(() => this.reconnectNow(), 1000 + Math.random() * 4000);
        return;
      case 0:
        this.onDispatch(payload.t ?? "", payload.d);
        return;
      default:
        return;
    }
  }

  private onDispatch(type: string, data: unknown): void {
    if (type === "READY") {
      const ready = data as {
        session_id: string;
        resume_gateway_url?: string;
        user: GatewayUser;
      };
      this.sessionId = ready.session_id;
      this.resumeUrl = ready.resume_gateway_url ?? null;
      this.user = ready.user;
      this.reconnectAttempts = 0;
      this.resolveReady?.(ready.user);
      this.handlers.onReady?.(ready.user);
      return;
    }

    if (type === "RESUMED") {
      this.reconnectAttempts = 0;
      return;
    }

    if (type === "VOICE_STATE_UPDATE") {
      const event = data as {
        guild_id: string;
        user_id: string;
        session_id: string;
        channel_id: string | null;
      };
      this.handlers.onVoiceState?.({
        guildId: event.guild_id,
        userId: event.user_id,
        sessionId: event.session_id,
        channelId: event.channel_id ?? null,
      });
      return;
    }

    if (type === "VOICE_SERVER_UPDATE") {
      const event = data as {
        guild_id: string;
        token: string;
        endpoint: string;
      };
      this.handlers.onVoiceServer?.({
        guildId: event.guild_id,
        token: event.token,
        endpoint: event.endpoint,
      });
    }
  }

  private startHeartbeat(interval: number): void {
    this.stopHeartbeat();
    this.acked = true;
    this.heartbeatTimer = setInterval(() => {
      // No ACK since the previous beat: Discord considers the socket a zombie.
      if (!this.acked) {
        this.reconnectNow();
        return;
      }
      this.sendHeartbeat();
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    this.acked = false;
    this.send({ op: 1, d: this.sequence });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private reconnectNow(): void {
    this.socket?.close(4000, "reconnect");
    this.socket = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts) + Math.random() * 500;
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open(this.gatewayUrl());
    }, delay);
  }
}

type GatewayPayload = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

/* ------------------------------------------------------------------ *
 * REST
 * ------------------------------------------------------------------ */

export class DiscordRestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function discordRest<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      authorization: `Bot ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new DiscordRestError(
      response.status,
      `Discord ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}
