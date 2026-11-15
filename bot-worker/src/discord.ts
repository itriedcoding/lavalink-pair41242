/**
 * Minimal Discord gateway client.
 *
 * The Convex bot answers HTTP interactions only, so it cannot set a presence:
 * Discord has no REST endpoint for a bot's status or custom activity. Presence
 * is a gateway op (op 3), which this worker sends over one socket per bot.
 *
 * Only GUILDS is requested, which is not a privileged intent and no message
 * content is read.
 */

import WebSocket from "ws";

export type GatewayUser = {
  id: string;
  username: string;
  global_name?: string | null;
};

export type PresenceStatus = "online" | "idle" | "dnd" | "invisible";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const INTENTS = 1; // GUILDS

type GatewayHandlers = {
  onReady?: (user: GatewayUser) => void;
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

  connect(): Promise<GatewayUser> {
    this.open(this.gatewayUrl());
    return this.ready;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.user !== null;
  }

  /** op 3: status plus an optional custom status line. */
  setPresence(status: PresenceStatus, text: string | null): void {
    const activities = text ? [{ name: "Custom Status", type: 4, state: text }] : [];
    this.send({
      op: 3,
      d: { since: null, activities, status, afk: false },
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
                browser: "roblox-manager-presence",
                device: "roblox-manager-presence",
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
    }
  }

  private startHeartbeat(interval: number): void {
    this.stopHeartbeat();
    this.acked = true;
    this.heartbeatTimer = setInterval(() => {
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
