# Bot worker

`/presence` needs a **gateway** connection: Discord has no REST endpoint for a
bot's status or custom status text, and Convex functions are short-lived request
handlers. This worker keeps one gateway socket per tenant bot and sends op 3
whenever the command changes the presence.

```
Convex ──/presence──▶ worker ──op 3──▶ Discord gateway
   ▲                     │
   └──/worker/bots───────┘   (credentials + saved presence)
```

## What it does

- Keeps one gateway connection per tenant bot (every workspace in the Convex
  `botConfigs` table), refetched every 5 minutes and on demand.
- Applies `online` / `idle` / `dnd` / `invisible` plus an optional custom status
  line, and re-applies the saved presence after every reconnect.
- Requests only the `GUILDS` intent — not privileged, no message content.
- Returns `{ ok, bots }` on `/health` so the dashboard can show whether the
  worker is reachable and how many bots are connected.

## Run it

```bash
cd bot-worker
cp env.example .env
# fill in CONVEX_SITE_URL and WORKER_SHARED_SECRET (must match the deployment)
bun install
bun start
```

Anywhere that runs a container works too:
`docker build -t bot-worker . && docker run -p 8099:8099 --env-file .env bot-worker`.

### Convex deployment environment

| Name | Value |
| --- | --- |
| `WORKER_URL` | public HTTPS origin of this worker |
| `WORKER_SHARED_SECRET` | the same secret as the worker's |

`/presence` reports a clear error while either one is missing.

## API

`POST /presence` with `Authorization: Bearer $WORKER_SHARED_SECRET`:

```json
{ "guildId": "123", "status": "idle", "text": "Back at 6pm" }
```

| Status | Meaning |
| --- | --- |
| 200 | presence applied (or queued until the gateway is ready) |
| 400 | unknown status or text over 128 characters |
| 409 | this guild's bot is not configured / connected |
| 502 | Discord connection or Convex failure (generic message, details in logs) |

`GET /health` is public: `{ "ok": true, "bots": 1 }`.

## Notes

- The worker must be always-on. A host that suspends idle services drops the
  gateway socket; the Convex deployment pings `/health` every 5 minutes to keep
  a free Render instance awake.
- Run one worker per bot token. Discord allows a single gateway session per
  token, and the Convex bot only uses HTTP interactions, so there is no
  competition for it.
- Presence changed in the Discord client is overwritten the next time the worker
  reconnects, because the saved state is re-applied.
