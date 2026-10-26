// Cross-instance plumbing for LAN rooms.
//
// On Vercel, every WebSocket is pinned to whatever function instance accepted it, and a
// LAN host and its guests can easily land on different instances. When REDIS_URL (or
// KV_URL) is set, room codes live in Redis and packets between instances travel over
// Redis pub/sub using Bun's built-in client (no npm dependency). Without Redis everything
// stays in memory, which is fine for a VPS / `bun run` or a single warm Vercel instance.
import { RedisClient } from "bun";

export type Loc = { inst: string; sid: string };
export type BusMsg = { t: string; [key: string]: unknown };
type Handler = (sid: string, msg: BusMsg) => void;

export interface Bus {
  readonly inst: string;
  readonly shared: boolean;
  /** Atomically claim key → value. Returns false if it already exists. */
  claim(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  touch(key: string, ttlSeconds: number): Promise<void>;
  release(key: string): Promise<void>;
  send(to: Loc, msg: BusMsg): void;
  onMessage(handler: Handler): void;
}

const PREFIX = "eagrelay:";

export function randomId(bytes = 8): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

// Uint8Array fields survive JSON as {$b: base64}.
// (Check holder[key], not v: Buffer.toJSON runs before the replacer sees the value.)
function encode(msg: unknown): string {
  return JSON.stringify(msg, function (this: Record<string, unknown>, k, v) {
    const raw = this[k];
    return raw instanceof Uint8Array ? { $b: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("base64") } : v;
  });
}
function decode(text: string): unknown {
  return JSON.parse(text, (_k, v) =>
    v && typeof v === "object" && typeof v.$b === "string" ? new Uint8Array(Buffer.from(v.$b, "base64")) : v);
}

class LocalBus implements Bus {
  readonly inst = randomId(6);
  readonly shared: boolean = false;
  protected handler: Handler = () => {};
  private kv = new Map<string, { value: string; expires: number }>();

  async claim(key: string, value: string, ttl: number) {
    const cur = this.kv.get(key);
    if (cur && cur.expires > Date.now()) return false;
    this.kv.set(key, { value, expires: Date.now() + ttl * 1000 });
    return true;
  }
  async get(key: string) {
    const cur = this.kv.get(key);
    if (!cur) return null;
    if (cur.expires <= Date.now()) {
      this.kv.delete(key);
      return null;
    }
    return cur.value;
  }
  async touch(key: string, ttl: number) {
    const cur = this.kv.get(key);
    if (cur) cur.expires = Date.now() + ttl * 1000;
  }
  async release(key: string) {
    this.kv.delete(key);
  }
  send(to: Loc, msg: BusMsg) {
    if (to.inst !== this.inst) return; // can't happen without Redis
    queueMicrotask(() => this.handler(to.sid, msg));
  }
  onMessage(handler: Handler) {
    this.handler = handler;
  }
}

class RedisBus extends LocalBus {
  override readonly shared = true;
  private ready: Promise<void>;
  private pub: RedisClient;

  constructor(url: string) {
    super();
    const pub = new RedisClient(url, { autoReconnect: true, enableOfflineQueue: true });
    this.pub = pub;
    this.ready = (async () => {
      await pub.connect();
      const sub = await pub.duplicate();
      await sub.subscribe(`${PREFIX}i:${this.inst}`, (raw: string) => {
        try {
          const { sid, msg } = decode(raw) as { sid: string; msg: BusMsg };
          this.handler(sid, msg);
        } catch (e) {
          console.warn("[relay] bad bus message", e);
        }
      });
    })();
    this.ready.catch((e) => console.error("[relay] redis connection failed:", e));
  }

  override async claim(key: string, value: string, ttl: number) {
    await this.ready;
    return (await this.pub.set(PREFIX + key, value, "NX", "EX", String(ttl))) === "OK";
  }
  override async get(key: string) {
    await this.ready;
    return (await this.pub.get(PREFIX + key)) ?? null;
  }
  override async touch(key: string, ttl: number) {
    await this.ready;
    await this.pub.expire(PREFIX + key, ttl);
  }
  override async release(key: string) {
    await this.ready;
    await this.pub.del(PREFIX + key);
  }
  override send(to: Loc, msg: BusMsg) {
    if (to.inst === this.inst) return super.send(to, msg); // same instance: skip the round trip
    this.ready
      .then(() => this.pub.publish(`${PREFIX}i:${to.inst}`, encode({ sid: to.sid, msg })))
      .catch((e) => console.warn("[relay] bus publish failed", e));
  }
}

export function createBus(redisUrl = process.env.REDIS_URL || process.env.KV_URL): Bus {
  if (!redisUrl) return new LocalBus();
  return new RedisBus(redisUrl);
}

export const locKey = (loc: Loc) => `${loc.inst}/${loc.sid}`;
export const parseLoc = (value: string | null): Loc | null => {
  if (!value) return null;
  const i = value.indexOf("/");
  return i > 0 ? { inst: value.slice(0, i), sid: value.slice(i + 1) } : null;
};
