# Eaglercraft 26.3 Relay — Vercel + Hono + Bun

The client and the relay are one Vercel project:

- The **26.3 client** is served from the CDN at `/play`.
- The **relay** runs as one Bun function with Hono routing and native Bun WebSockets.

The client defaults to this site as its relay, so players open `https://your-app.vercel.app` and play.

| Path | What it does |
|---|---|
| `/` | Browser visit: redirects to `/play`. WebSocket: classic LAN signaling relay. |
| `/minecraft?target=host:port` | Java Edition server tunnel. Works with any protocol version, including 26.3. |
| `/lan/host`, `/lan/join?code=` | Relayed LAN rooms |
| `/health` | JSON status |

## Deploy

```bash
bun install
bunx vercel login
bunx vercel deploy --prod
```

Or push to GitHub and import the repo in Vercel. `vercel.json` already sets the Bun runtime, the routes, and the function's max duration.

> `public/play/index.html` is about 76 MB. GitHub accepts it but warns about files over 50 MB, and the Vercel CLI accepts it.

### Strongly recommended: add Redis

Vercel can put a LAN host and a guest on different function instances. When that happens, the guest gets "no LAN world found."

To fix it, add **Redis** from the Vercel Marketplace (Storage → Redis). That sets `REDIS_URL`, which the relay picks up automatically. It uses Bun's built-in Redis client, so no extra package is needed. `/health` shows `"sharedRooms": true` when it's working.

## Vercel limits (read this)

Every WebSocket on Vercel is closed when the function hits its max duration:

| Plan | Max connection length |
|---|---|
| Hobby | 300 s (≈5 min) |
| Pro | 800 s, or 1800 s (extended, beta) |

On Hobby, players on Java servers get disconnected about every 5 minutes. The relay closes a few seconds early with "relay session limit reached, reconnect" so the client gets a clean message.

On Pro, raise the limit in two places:

1. `"maxDuration"` in `vercel.json` (for example 800).
2. The `RELAY_VERCEL_MAX_DURATION` env var, set to the same number.

If you want unlimited sessions, run the same code on a VPS (below).

Costs: relaying game traffic is billed as Active CPU plus data transfer.

## Run anywhere else (no time limits)

```bash
bun install
bun start            # http://localhost:8787  (client at /play)
```

## Updating the client

```bash
bun run client path/to/eaglercraft26-3.html
```

This copies the client to `public/play/index.html` and injects this site as the default relay. Relays already saved in a player's browser still take priority.

## Private mode

1. Set `RELAY_PUBLIC=0` and `RELAY_SECRET` (16+ characters) in your Vercel env vars.
2. Mint tokens:

```bash
RELAY_SECRET=... bun run token mc.example.com:25565 3600
RELAY_SECRET=... bun run token --lan-host 21600
```

Tokens from the old Node and Cloudflare relays stay valid; the format is the same.

## Settings (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_PUBLIC` | `1` | `0` requires tokens |
| `RELAY_SECRET` | — | Required when private |
| `REDIS_URL` / `KV_URL` | — | Enables cross-instance LAN rooms |
| `RELAY_VERCEL_MAX_DURATION` | `300` | Keep equal to `maxDuration` in `vercel.json` |
| `RELAY_MAX_LIFETIME_MS` | auto | Overrides the per-connection cap |
| `RELAY_ALLOWED_ORIGINS` | — | Comma-separated browser origins |
| `RELAY_MAX_BYTES_PER_MINUTE` | 64 MiB | Per Java connection |
| `RELAY_MAX_LAN_BYTES_PER_MINUTE` | 512 MiB | Per LAN peer |
| `RELAY_MAX_LAN_PEERS` | `8` | Guests per LAN room |
| `RELAY_ICE_SERVERS` | Google + Cloudflare STUN | `stun:host:port` or `turn:host:port;user;pass` |
| `RELAY_ALLOW_PRIVATE` | `0` | Allow LAN/private targets. Never enable this on a public relay. |
| `RELAY_TRACE` | `0` | Per-connection logs |

## Tests

```bash
bun test
```

The cross-instance tests need a Redis server on `127.0.0.1:6390` (or set `TEST_REDIS_URL`). If none is running, they're skipped.

MIT, same as the original relay.
