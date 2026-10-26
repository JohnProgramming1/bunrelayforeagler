// Eaglercraft 26.3 relay: Hono for HTTP routing, native Bun WebSockets for the hot path.
//
//   GET /            WebSocket → classic LAN signaling relay; plain browser visit → /play
//   GET /minecraft   WebSocket → Java Edition TCP tunnel (?target=host:port[&token=])
//   GET /lan/host    WebSocket → relayed LAN room host (?token= when private)
//   GET /lan/join    WebSocket → relayed LAN room guest (?code=XXXXXX)
//   GET /health      JSON status
import dns from "node:dns/promises";
import { Hono, type Context } from "hono";
import type { Server, WebSocketHandler } from "bun";
import { createBus, randomId, type Bus } from "./bus.ts";
import { loadConfig, type RelayConfig } from "./config.ts";
import { verifyScopedToken, verifyToken } from "./auth.ts";
import { isPrivateTarget, parseTarget } from "./protocol.ts";
import { MinecraftSession } from "./minecraft.ts";
import { LegacyLanSession } from "./legacy-lan.ts";
import { LanGuestSession, LanHostSession } from "./lan-rooms.ts";
import type { Deps, Session, SocketData } from "./session.ts";

// vercel.json rewrites everything into /api/server?__route=<name>. Depending on how the
// platform hands us the URL we may see the original path or the rewritten one, so
// normalise both forms back to the public path before Hono routes it.
const ROUTES: Record<string, string> = {
  root: "/", minecraft: "/minecraft", "lan-host": "/lan/host", "lan-join": "/lan/join", health: "/health", play: "/play",
};

function logicalPath(req: Request): string {
  const url = new URL(req.url);
  const route = url.searchParams.get("__route");
  if (route) return ROUTES[route] ?? "/__unknown";
  const p = url.pathname;
  if (p === "/api/server" || p.startsWith("/api/server/")) return p.slice("/api/server".length) || "/";
  return p;
}

async function assertPublicDestination(host: string, allowPrivate: boolean): Promise<string> {
  if (allowPrivate) return host;
  if (isPrivateTarget(host)) throw new Error("private destinations are disabled");
  const addrs = await dns.lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0 || addrs.some(({ address }) => isPrivateTarget(address))) {
    throw new Error("target resolves to a private destination");
  }
  // Connect to the address we just vetted so DNS can't be rebound between check and connect.
  return addrs[0]!.address;
}

type Env = { Bindings: Server<SocketData> };

export type Relay = {
  fetch: (req: Request, server: Server<SocketData>) => Response | Promise<Response>;
  websocket: WebSocketHandler<SocketData>;
  config: RelayConfig;
  bus: Bus;
  sessions: Map<string, Session>;
};

export function createRelay(opts: { config?: Partial<RelayConfig>; env?: Record<string, string | undefined>; bus?: Bus } = {}): Relay {
  const cfg = loadConfig(opts.env ?? process.env, opts.config);
  const bus = opts.bus ?? createBus(opts.env ? (opts.env.REDIS_URL || opts.env.KV_URL || "") : undefined);
  const deps: Deps = { cfg, bus };
  const sessions = new Map<string, Session>();

  bus.onMessage((sid, msg) => sessions.get(sid)?.onBus?.(msg));

  const app = new Hono<Env>({ getPath: logicalPath });

  const reject = (c: Context<Env>, status: 400 | 401 | 403 | 404 | 426, message: string) =>
    c.text(`${message}\n`, status, { "cache-control": "no-store" });

  function upgrade(c: Context<Env>, make: (sid: string) => Session): Response {
    const sid = randomId(8);
    const session = make(sid);
    if (!c.env.upgrade(c.req.raw, { data: { sid, session } })) return reject(c, 426, "websocket upgrade failed");
    return new Response(null); // ignored by Bun after a successful upgrade
  }

  const isWebSocket = (c: Context<Env>) => c.req.header("upgrade")?.toLowerCase() === "websocket";

  // Origin allow-list for every WebSocket route.
  app.use("*", async (c, next) => {
    if (isWebSocket(c) && cfg.allowedOrigins.length && !cfg.allowedOrigins.includes(c.req.header("origin") ?? "")) {
      return reject(c, 403, "origin is not allowed");
    }
    await next();
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      protocol: "minecraft-java-byte-stream-v1",
      lan: "eagler-1.8-webrtc-p2p-v1",
      capabilities: ["singleplayer", "multiplayer"],
      public: cfg.publicAccess,
      runtime: typeof Bun !== "undefined" ? `bun-${Bun.version}` : "unknown",
      vercel: Boolean(process.env.VERCEL),
      sharedRooms: bus.shared,
      sessionLimitSeconds: Math.round(cfg.maxLifetimeMs / 1000),
      client: "26.3",
    }, 200, { "cache-control": "no-store" }));

  app.get("/", (c) => {
    if (!isWebSocket(c)) return c.redirect("/play", 302);
    return upgrade(c, (sid) => new LegacyLanSession(deps, sid));
  });

  app.get("/minecraft", async (c) => {
    if (!isWebSocket(c)) return reject(c, 426, "websocket required");
    let target;
    let connectHost;
    try {
      target = parseTarget(c.req.query("target"));
      if (!cfg.publicAccess) await verifyToken(cfg.secret, c.req.query("token"), target.canonical);
      connectHost = await assertPublicDestination(target.host, cfg.allowPrivate);
    } catch (e) {
      return reject(c, 401, (e as Error).message);
    }
    return upgrade(c, () => new MinecraftSession(deps, target, connectHost));
  });

  app.get("/lan/host", async (c) => {
    if (!isWebSocket(c)) return reject(c, 426, "websocket required");
    if (!cfg.publicAccess) {
      try {
        await verifyScopedToken(cfg.secret, c.req.query("token"), "lan-host");
      } catch (e) {
        return reject(c, 401, (e as Error).message);
      }
    }
    return upgrade(c, (sid) => new LanHostSession(deps, sid));
  });

  app.get("/lan/join", (c) => {
    if (!isWebSocket(c)) return reject(c, 426, "websocket required");
    const code = String(c.req.query("code") ?? "").toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6,10}$/.test(code)) return reject(c, 401, "LAN room is unavailable");
    return upgrade(c, (sid) => new LanGuestSession(deps, sid, code));
  });

  // Local dev / VPS convenience. On Vercel, /play is served by the CDN from public/.
  app.get("/play", async (c) => {
    const file = Bun.file(cfg.clientPath);
    if (!(await file.exists())) return c.text("client not found; run `bun run client <path-to-html>`\n", 404);
    return new Response(file, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error("[relay]", err);
    return c.json({ error: "internal error" }, 500);
  });

  const websocket: WebSocketHandler<SocketData> = {
    maxPayloadLength: 2 * 1024 * 1024,
    perMessageDeflate: false,
    idleTimeout: 960, // seconds; Bun also auto-pings so idle-but-alive sockets stay up
    sendPings: true,
    open(ws) {
      sessions.set(ws.data.sid, ws.data.session);
      ws.data.session.open(ws);
    },
    message(ws, message) {
      ws.data.session.message(ws, message);
    },
    close(ws, code, reason) {
      sessions.delete(ws.data.sid);
      ws.data.session.close(code, reason);
    },
  };

  return { fetch: (req, server) => app.fetch(req, server), websocket, config: cfg, bus, sessions };
}
