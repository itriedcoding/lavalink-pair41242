/**
 * Lavalink v4 client: one session per tenant bot (Lavalink identifies to the
 * voice gateway as that bot), plus REST calls for loading tracks and updating
 * players.
 */

import WebSocket from "ws";

export type LavalinkTrack = {
  encoded: string;
  info: {
    identifier: string;
    title: string;
    author: string;
    length: number;
    uri?: string | null;
    artworkUrl?: string | null;
    isStream?: boolean;
  };
};

export type LavalinkEvent =
  | { op: "event"; type: "TrackStartEvent"; guildId: string; track: LavalinkTrack }
  | {
      op: "event";
      type: "TrackEndEvent";
      guildId: string;
      track: LavalinkTrack;
      reason: string;
    }
  | {
      op: "event";
      type: "TrackExceptionEvent";
      guildId: string;
      track: LavalinkTrack;
      exception?: { message?: string; severity?: string };
    }
  | {
      op: "playerUpdate";
      guildId: string;
      state: { position: number; connected: boolean; ping?: number };
    };

export type LoadResult =
  | { loadType: "track"; data: LavalinkTrack }
  | { loadType: "playlist"; data: { info: { name: string }; tracks: LavalinkTrack[] } }
  | { loadType: "search"; data: LavalinkTrack[] }
  | { loadType: "empty"; data: Record<string, never> }
  | { loadType: "error"; data: { message?: string; severity?: string } };

export class LavalinkError extends Error {}

function httpBase(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  return parsed.toString().replace(/\/+$/, "");
}

function wsBase(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  return parsed.toString().replace(/\/+$/, "");
}

export class LavalinkNode {
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private connecting: Promise<string> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly password: string,
    private readonly clientName: string,
    private readonly userId: string,
    private readonly handlers: {
      onEvent: (event: LavalinkEvent) => void;
      onSession?: (sessionId: string) => void;
    },
  ) {}

  get name(): string {
    return this.clientName;
  }

  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    if (!this.connecting) {
      const attempt = this.open();
      this.connecting = attempt;
      const clear = () => {
        this.connecting = null;
      };
      attempt.then(clear, clear);
    }
    return this.connecting;
  }

  async load(identifier: string): Promise<LoadResult> {
    const response = await fetch(
      `${httpBase(this.url)}/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`,
      { headers: { authorization: this.password } },
    );
    if (!response.ok) {
      throw new LavalinkError(
        `Lavalink could not load \`${identifier}\` (${response.status}). Check that the source plugin is installed.`,
      );
    }
    const result = (await response.json()) as LoadResult;
    if (result.loadType === "error") {
      const message = result.data?.message ?? "Lavalink rejected the search.";
      throw new LavalinkError(`Lavalink could not load that query: ${message}`);
    }
    return result;
  }

  async updatePlayer(guildId: string, body: Record<string, unknown>): Promise<void> {
    const sessionId = await this.ensureSession();
    const response = await fetch(
      `${httpBase(this.url)}/v4/sessions/${sessionId}/players/${guildId}`,
      {
        method: "PATCH",
        headers: {
          authorization: this.password,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new LavalinkError(
        `Lavalink rejected the player update (${response.status}): ${text.slice(0, 300)}`,
      );
    }
  }

  async destroyPlayer(guildId: string): Promise<void> {
    if (!this.sessionId) return;
    await fetch(`${httpBase(this.url)}/v4/sessions/${this.sessionId}/players/${guildId}`, {
      method: "DELETE",
      headers: { authorization: this.password },
    }).catch(() => undefined);
  }

  destroy(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "worker shutdown");
    this.socket = null;
  }

  private open(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const url = `${wsBase(this.url)}/v4/websocket?clientName=${encodeURIComponent(
        this.clientName,
      )}&userId=${encodeURIComponent(this.userId)}`;

      // Lavalink's WS handshake needs all three: the password plus the same
      // user/client identity it also sees in the query string. Nodes behind a
      // proxy reject sessions that only send Authorization.
      const socket = new WebSocket(url, {
        headers: {
          Authorization: this.password,
          "User-Id": this.userId,
          "Client-Name": this.clientName,
        },
      });
      this.socket = socket;

      const timer = setTimeout(() => {
        reject(new LavalinkError("Lavalink did not send a ready event within 10 seconds."));
        socket.close();
      }, 10_000);

      socket.on("message", (raw) => {
        let message: {
          op?: string;
          sessionId?: string;
          guildId?: string;
          type?: string;
          track?: LavalinkTrack;
          reason?: string;
          exception?: { message?: string; severity?: string };
          state?: { position: number; connected: boolean; ping?: number };
        };
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (message.op === "ready" && message.sessionId) {
          clearTimeout(timer);
          this.sessionId = message.sessionId;
          this.reconnectAttempts = 0;
          resolve(message.sessionId);
          this.handlers.onSession?.(message.sessionId);
          return;
        }

        if (message.op === "event" && message.type && message.guildId) {
          this.handlers.onEvent(message as LavalinkEvent);
          return;
        }

        if (message.op === "playerUpdate" && message.guildId && message.state) {
          this.handlers.onEvent(message as LavalinkEvent);
        }
      });

      socket.on("close", () => {
        clearTimeout(timer);
        this.socket = null;
        this.sessionId = null;
        reject(
          new LavalinkError(
            "Lavalink closed the connection. Check LAVALINK_URL, LAVALINK_PASSWORD and that the server is up.",
          ),
        );
        if (!this.stopped) this.scheduleReconnect();
      });

      socket.on("error", () => {
        clearTimeout(timer);
        reject(
          new LavalinkError(
            "Could not connect to Lavalink. Check LAVALINK_URL and LAVALINK_PASSWORD.",
          ),
        );
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSession().catch(() => this.scheduleReconnect());
    }, delay);
  }
}
