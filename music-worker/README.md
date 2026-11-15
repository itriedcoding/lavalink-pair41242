# Music worker

`/play` needs two things Convex cannot provide: a permanent Discord **gateway**
socket and a Lavalink session. Discord sends voice state/server updates over the
gateway only, and Lavalink needs those to open the UDP voice connection. Convex
functions are short-lived request handlers, so this worker owns those
connections and exposes a small JSON API that Convex calls.

```
Discord ──gateway──▶ worker ──REST──▶ Lavalink ──UDP──▶ Discord voice
   ▲                    │
   └──player message────┘
Convex ──/play, /control──▶ worker          worker ──/music/bots──▶ Convex
```

## What it does

- Keeps one gateway connection per tenant bot (every workspace in the Convex
  `botConfigs` table), refetched every 5 minutes and on demand.
- Joins the caller's voice channel, searches Lavalink, queues tracks and
  advances on `TrackEndEvent`.
- Owns the player message: embed + five buttons (`Play`, `Pause`, `Stop`,
  `Volume −`, `Volume +`). Convex receives the button clicks and forwards them;
  the worker edits the message itself.
- Rejects controls from members who are not in the bot's voice channel.
- Uses only `GUILDS` + `GUILD_VOICE_STATES` intents — neither is privileged.

Run this worker **once per bot token**. Discord allows a single gateway session
per token, so two workers (or another gateway bot sharing the token) will keep
disconnecting each other. The main Convex bot only uses HTTP interactions, so it
does not compete for the session.

## Requirements

- Bun 1.1+ (recommended) or Node 22.6+ for the worker.
- Lavalink v4. The worker defaults to the public **Trinium** node
  (`lavalink-v4.triniumhost.com:443`, password `free`), which serves YouTube
  search and direct links. Self-hosting with the bundled
  `lavalink/application.yml` (youtube-plugin included) is the production path;
  the Serenetia node works as an alternative.
- A public HTTPS URL for the worker (reverse proxy, Fly.io, Railway, Render or a
  VPS). Convex must be able to reach it.
- Bot permissions in the server: **Connect**, **Speak**, **Send Messages**,
  **Embed Links**, **Read Message History**. The bot also needs access to the
  voice channel.

## Setup

### 1. Lavalink

**Default — public node.** Leave `LAVALINK_URL` / `LAVALINK_PASSWORD` unset (or
as in `env.example`) and the worker uses `lavalink-v4.triniumhost.com:443`. It
is shared, so expect queueing at busy times and check the operator's rules.

**Self-hosted (production).**

```bash
cd music-worker
cp env.example .env          # set LAVALINK_PASSWORD here too
docker compose up -d
curl -H "Authorization: $LAVALINK_PASSWORD" http://127.0.0.1:2333/version
```

Then set `LAVALINK_URL=http://127.0.0.1:2333`, the same `LAVALINK_PASSWORD` and
`LAVALINK_NAME=main` in `.env`. If Lavalink refuses to start, the pinned
`youtube-plugin` version in `lavalink/application.yml` may not exist any more —
bump it to a current release from the plugin repo. Spotify/Apple/Deezer links
need the [LavaSrc](https://github.com/topi314/LavaSrc) plugin added to the same
file; `/play` already accepts links, but Lavalink only resolves sources it has.

### 2. Convex deployment environment

In the Convex dashboard → Settings → Environment Variables, add:

| Name | Value |
| --- | --- |
| `MUSIC_SHARED_SECRET` | a long random string, identical to the worker's |
| `MUSIC_WORKER_URL` | public HTTPS origin of this worker, e.g. `https://music.example.com` |

`/play` reports a clear error while either one is missing.

### 3. Worker

```bash
cd music-worker
cp env.example .env
# fill in CONVEX_SITE_URL and MUSIC_SHARED_SECRET
bun install
bun start
```

Anywhere that runs a container can host it instead: `docker build -t music-worker .`
then `docker run -p 8099:8099 --env-file .env music-worker`.

Check it:

```bash
curl http://127.0.0.1:8099/health
# {"ok":true,"bots":1}
```

### 4. Discord

Redeploy the commands from the dashboard's Commands tab (this registers
`/play`), then run `/play query:…` from a voice channel.

## Deploy on Render

`render.yaml` at the repo root defines the service:
`roblox-manager-music-7f3a91`, built from `music-worker/Dockerfile`, health
check `/health`, **Starter** plan (the free plan sleeps and would drop the
gateway/voice connection).

1. Push this repository to GitHub — Render deploys from a Git repo, and this
   workspace has no remote configured yet.
2. Render → **New → Blueprint** → pick the repo. Render reads `render.yaml`.
3. When asked for `MUSIC_SHARED_SECRET`, paste the value from the Convex
   dashboard (`npx convex env get MUSIC_SHARED_SECRET`).
4. The service URL is `https://roblox-manager-music-7f3a91.onrender.com`, already
   set as `MUSIC_WORKER_URL`. If Render had to rename the service, set the real
   URL instead:

   ```bash
   npx convex env set MUSIC_WORKER_URL https://<real-name>.onrender.com
   ```

5. `curl https://roblox-manager-music-7f3a91.onrender.com/health` → `{"ok":true,…}`.

## API

All routes except `/health` require `Authorization: Bearer $MUSIC_SHARED_SECRET`
and accept `POST` with JSON.

| Route | Body | Result |
| --- | --- | --- |
| `/play` | `{ guildId, userId, textChannelId, query }` | `{ status, track, queueLength, volume, voiceChannelId }` |
| `/control` | `{ guildId, userId, action }` — `play`, `pause`, `stop`, `volup`, `voldown` | `{ ok, state }` |
| `/state` | `{ guildId }` | `{ state }` |
| `/health` | — | `{ ok, bots }` |

User-facing problems come back as `{ "error": "…" }` with status `409`; Lavalink
and Discord failures are `502` and are also shown in the Discord reply.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Music is not set up yet` | `MUSIC_WORKER_URL` / `MUSIC_SHARED_SECRET` missing in Convex |
| `Could not reach the music worker` | worker down, wrong URL, or TLS/proxy problem |
| `This server's bot is not connected` | worker could not read `/music/bots`; check the shared secret matches |
| `Discord did not finish joining the voice channel` | bot lacks Connect/Speak, or channel is full/user limit |
| `Lavalink found nothing` | youtube-plugin missing or the query has no results |
| `Lavalink did not send a ready event` | wrong `LAVALINK_URL`/`LAVALINK_PASSWORD`, or Lavalink still starting |

The worker logs every gateway connection, Lavalink reconnect and request failure
with a timestamp; check that output first.
