import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BotPool } from "./bots.ts";
import { loadConfig } from "./config.ts";
import { BadRequestError, MusicError, messageOf } from "./errors.ts";

const CONTROLS = ["play", "pause", "stop", "volup", "voldown"] as const;
type Control = (typeof CONTROLS)[number];

const config = loadConfig(process.env);

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

const pool = new BotPool(config, log);

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function authorized(header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${config.sharedSecret}`);
  const provided = Buffer.from(header);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_768) throw new BadRequestError("Request body is too large.");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new BadRequestError("Request body must be JSON.");
  }
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new BadRequestError(`\`${field}\` is required.`);
  }
  return value;
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;

  if (path === "/health") {
    send(response, 200, { ok: true, bots: pool.size });
    return;
  }

  if (!["/play", "/control", "/state"].includes(path)) {
    send(response, 404, { error: "Not found" });
    return;
  }

  if (request.method !== "POST") {
    send(response, 405, { error: "POST required" });
    return;
  }

  if (!authorized(request.headers.authorization)) {
    send(response, 401, { error: "Unauthorized" });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch (error) {
    send(response, 400, { error: messageOf(error) });
    return;
  }

  try {
    if (path === "/play") {
      const guildId = stringField(body, "guildId");
      const userId = stringField(body, "userId");
      const textChannelId = stringField(body, "textChannelId");
      const query = stringField(body, "query").slice(0, 300);

      const connection = await pool.ensureGuild(guildId);
      const outcome = await connection.play(guildId, userId, textChannelId, query);
      send(response, 200, outcome);
      return;
    }

    if (path === "/control") {
      const guildId = stringField(body, "guildId");
      const userId = stringField(body, "userId");
      const action = stringField(body, "action");
      if (!CONTROLS.includes(action as Control)) {
        send(response, 400, { error: `Unknown control \`${action}\`.` });
        return;
      }

      const connection = await pool.ensureGuild(guildId);
      await connection.control(guildId, userId, action as Control);
      send(response, 200, { ok: true, state: connection.state(guildId) });
      return;
    }

    const guildId = stringField(body, "guildId");
    send(response, 200, { state: pool.find(guildId)?.state(guildId) ?? null });
  } catch (error) {
    const text = messageOf(error);
    const status =
      error instanceof BadRequestError ? 400 : error instanceof MusicError ? 409 : 502;
    if (status === 502) log("request failed:", text);
    // Lavalink/Discord errors are actionable; anything else is internal detail.
    const reply =
      status === 502 && !/^(Lavalink|Discord)/.test(text)
        ? "The music worker hit an internal error. Check its logs."
        : text;
    send(response, status, { error: reply });
  }
}

const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    log("unhandled request error:", messageOf(error));
    if (!response.headersSent) send(response, 500, { error: "Internal worker error." });
    else response.end();
  });
});

server.listen(config.port, () => {
  log(`music worker listening on :${config.port}`);
});

await pool.start().catch((error) => {
  log("could not load bot credentials:", messageOf(error));
  log("the worker stays up; /play will retry once Convex is reachable");
});

function shutdown(signal: string): void {
  log(`${signal} received, shutting down`);
  server.close();
  pool.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
