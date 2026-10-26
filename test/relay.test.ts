import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createRelay, type Relay } from "../src/relay.ts";
import { createToken, verifyToken, verifyScopedToken, createScopedToken } from "../src/auth.ts";
import { isPrivateTarget, makeHandshake, parseTarget, validateMinecraftHandshake } from "../src/protocol.ts";
import { parseHostFrame, peerFrame } from "../src/lan-rooms.ts";
import { createBus } from "../src/bus.ts";

// ---------- helpers ----------
type Msg = string | Uint8Array;
class Client {
  ws: WebSocket;
  inbox: Msg[] = [];
  waiters: ((m: Msg) => void)[] = [];
  closed: Promise<{ code: number; reason: string }>;
  opened: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.opened = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error("ws error"));
    });
    this.closed = new Promise((res) => (this.ws.onclose = (e) => res({ code: e.code, reason: e.reason })));
    this.ws.onmessage = (e) => {
      const m: Msg = typeof e.data === "string" ? e.data : new Uint8Array(e.data);
      const w = this.waiters.shift();
      if (w) w(m);
      else this.inbox.push(m);
    };
  }
  next(timeout = 3000): Promise<Msg> {
    const m = this.inbox.shift();
    if (m !== undefined) return Promise.resolve(m);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout waiting for message")), timeout);
      this.waiters.push((x) => {
        clearTimeout(t);
        res(x);
      });
    });
  }
  async nextBytes() {
    const m = await this.next();
    if (typeof m === "string") throw new Error(`expected binary, got ${m}`);
    return m;
  }
  async nextJson() {
    const m = await this.next();
    if (typeof m !== "string") throw new Error("expected text");
    return JSON.parse(m);
  }
  send(d: Uint8Array | string) {
    this.ws.send(d);
  }
}

const cat = (...parts: (number[] | Uint8Array)[]) => {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};
const a8 = (s: string) => cat([s.length], new TextEncoder().encode(s));
const readA8 = (b: Uint8Array, off: number) => new TextDecoder().decode(b.subarray(off + 1, off + 1 + b[off]!));
const peerPkt = (type: number, peer: string, payload: number[]) => cat([type], a8(peer), [payload.length >> 8, payload.length & 255], payload);

function startRelay(env: Record<string, string>) {
  const relay = createRelay({ env });
  const server = Bun.serve({ port: 0, fetch: relay.fetch, websocket: relay.websocket });
  return { relay, server, url: `ws://127.0.0.1:${server.port}`, http: `http://127.0.0.1:${server.port}` };
}

// ---------- unit ----------
describe("protocol", () => {
  test("parseTarget", () => {
    expect(parseTarget("mc.example.com")).toEqual({ host: "mc.example.com", port: 25565, canonical: "mc.example.com:25565" });
    expect(parseTarget("[::1]:1234").canonical).toBe("[::1]:1234");
    expect(() => parseTarget("smtp.example.com:25")).toThrow();
    expect(() => parseTarget("a:b:c")).toThrow();
  });
  test("private targets", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "localhost", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateTarget(h)).toBe(true);
    }
    expect(isPrivateTarget("8.8.8.8")).toBe(false);
  });
  test("handshake accepts any protocol version (26.3 included)", () => {
    for (const proto of [47, 767, 776, 780, 999999]) {
      const r = validateMinecraftHandshake(makeHandshake("play.example.net", 25565, proto, 2));
      expect(r.status).toBe("valid");
    }
    const hs = makeHandshake("a.b", 25565);
    expect(validateMinecraftHandshake(hs.subarray(0, 4)).status).toBe("more");
    expect(validateMinecraftHandshake(Uint8Array.from([6, 1, 1, 1, 1, 1, 1])).status).toBe("invalid");
    expect(validateMinecraftHandshake(makeHandshake("a.b", 25565, 776, 3)).status).toBe("valid"); // transfer intent
  });
});

describe("auth", () => {
  const secret = "0123456789abcdef-secret";
  test("roundtrip + wrong target", async () => {
    const t = await createToken(secret, "mc.example.com:25565");
    await verifyToken(secret, t, "mc.example.com");
    expect(verifyToken(secret, t, "other.example.com")).rejects.toThrow();
    const lan = await createScopedToken(secret, "lan-host");
    await verifyScopedToken(secret, lan, "lan-host");
    expect(verifyScopedToken(secret, lan, "nope")).rejects.toThrow();
  });
  test("accepts tokens minted by the original Node relay", async () => {
    const payload = Buffer.from(JSON.stringify({ v: 1, target: "mc.example.com:25565", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    const sig = createHmac("sha256", secret).update(payload).digest("base64url");
    await verifyToken(secret, `${payload}.${sig}`, "mc.example.com:25565");
  });
});

test("lan frame codec", () => {
  const f = peerFrame("abcdef0123456789", Uint8Array.from([9, 8, 7]));
  const p = parseHostFrame(f);
  expect(p.peerId).toBe("abcdef0123456789");
  expect([...p.payload]).toEqual([9, 8, 7]);
});

// ---------- integration ----------
describe("relay (single instance)", () => {
  let r: ReturnType<typeof startRelay>;
  let mc: import("bun").TCPSocketListener<undefined>;
  const received: Uint8Array[] = [];

  beforeAll(() => {
    r = startRelay({ RELAY_PUBLIC: "1", RELAY_ALLOW_PRIVATE: "1" });
    // Fake Java server: replies "OK" + echoes everything after the handshake.
    mc = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(s) { s.write("OK"); },
        data(s, d) { received.push(new Uint8Array(d)); s.write(d); },
      },
    });
  });
  afterAll(() => {
    r.server.stop(true);
    mc.stop(true);
  });

  test("health + routing aliases + browser redirect", async () => {
    const h = (await (await fetch(`${r.http}/health`)).json()) as { ok: boolean; client: string };
    expect(h.ok).toBe(true);
    expect(h.client).toBe("26.3");
    expect((await fetch(`${r.http}/api/server?__route=health`)).status).toBe(200);
    expect((await fetch(`${r.http}/api/server/health`)).status).toBe(200);
    const home = await fetch(`${r.http}/`, { redirect: "manual" });
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe("/play");
  });

  test("minecraft tunnel pipes bytes both ways", async () => {
    const c = new Client(`${r.url}/minecraft?target=127.0.0.1:${mc.port}`);
    await c.opened;
    expect(new TextDecoder().decode(await c.nextBytes())).toBe("OK");
    const hs = makeHandshake("127.0.0.1", mc.port, 776, 2);
    c.send(hs.subarray(0, 3)); // split handshake across frames
    c.send(hs.subarray(3));
    c.send(Uint8Array.from([1, 2, 3, 4]));
    let echoed = new Uint8Array();
    while (echoed.length < hs.length + 4) echoed = cat(echoed, await c.nextBytes());
    expect([...echoed.subarray(hs.length)]).toEqual([1, 2, 3, 4]);
    c.ws.close();
  });

  test("minecraft tunnel via rewritten path", async () => {
    const c = new Client(`${r.url}/api/server?__route=minecraft&target=127.0.0.1:${mc.port}`);
    await c.opened;
    expect(new TextDecoder().decode(await c.nextBytes())).toBe("OK");
    c.ws.close();
  });

  test("rejects a non-handshake first packet", async () => {
    const c = new Client(`${r.url}/minecraft?target=127.0.0.1:${mc.port}`);
    await c.opened;
    c.send(Uint8Array.from([6, 5, 1, 1, 1, 1, 1]));
    expect((await c.closed).code).toBe(1008);
  });

  test("rejects handshake port mismatch", async () => {
    const c = new Client(`${r.url}/minecraft?target=127.0.0.1:${mc.port}`);
    await c.opened;
    c.send(makeHandshake("127.0.0.1", 1));
    expect((await c.closed).code).toBe(1008);
  });

  test("blocks private targets when not allowed", async () => {
    const pub = startRelay({ RELAY_PUBLIC: "1" });
    const res = await fetch(`${pub.http}/minecraft?target=127.0.0.1:25565`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("private");
    pub.server.stop(true);
  });

  test("private mode requires a token", async () => {
    const secret = "0123456789abcdef-secret";
    const priv = startRelay({ RELAY_PUBLIC: "0", RELAY_SECRET: secret, RELAY_ALLOW_PRIVATE: "1" });
    const res = await fetch(`${priv.http}/minecraft?target=127.0.0.1:${mc.port}`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(401);
    const tok = await createToken(secret, `127.0.0.1:${mc.port}`);
    const c = new Client(`${priv.url}/minecraft?target=127.0.0.1:${mc.port}&token=${tok}`);
    await c.opened;
    expect(new TextDecoder().decode(await c.nextBytes())).toBe("OK");
    c.ws.close();
    priv.server.stop(true);
  });

  test("legacy LAN signaling: ping/pong", async () => {
    const c = new Client(`${r.url}/`);
    await c.opened;
    c.send(cat([0, 3, 1], a8("")));
    const pong = await c.nextBytes();
    expect(pong[0]).toBe(0x69);
    expect((await c.closed).code).toBe(1000);
  });

  test("legacy LAN signaling: full host/guest exchange", async () => {
    await legacyFlow(r.url, r.url);
  });

  test("framed LAN room: host/join/data/close", async () => {
    await framedFlow(r.url, r.url);
  });
});

async function legacyFlow(hostUrl: string, guestUrl: string) {
  const host = new Client(`${hostUrl}/`);
  await host.opened;
  host.send(cat([0, 1, 1], a8("")));
  const hs = await host.nextBytes();
  expect([...hs.subarray(0, 3)]).toEqual([0, 1, 1]);
  const code = readA8(hs, 3);
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  expect((await host.nextBytes())[0]).toBe(0x01); // ICE servers

  const guest = new Client(`${guestUrl}/`);
  await guest.opened;
  guest.send(cat([0, 2, 1], a8(code.toLowerCase())));
  const ghs = await guest.nextBytes();
  expect([...ghs.subarray(0, 3)]).toEqual([0, 2, 1]);
  const id = readA8(ghs, 3);
  expect((await guest.nextBytes())[0]).toBe(0x01);
  const newClient = await host.nextBytes();
  expect(newClient[0]).toBe(0x02);
  expect(readA8(newClient, 1)).toBe(id);

  guest.send(peerPkt(0x04, "", [1, 2, 3])); // guest description
  const d1 = await host.nextBytes();
  expect(d1[0]).toBe(0x04);
  expect(readA8(d1, 1)).toBe(id);
  host.send(peerPkt(0x04, id, [4, 5])); // host description
  const d2 = await guest.nextBytes();
  expect([...d2]).toEqual([...peerPkt(0x04, "", [4, 5])]);
  guest.send(peerPkt(0x03, "", [6])); // guest ICE
  expect((await host.nextBytes())[0]).toBe(0x03);
  host.send(peerPkt(0x03, id, [7])); // host ICE
  expect((await guest.nextBytes())[0]).toBe(0x03);
  guest.send(cat([0x05], a8(""))); // success
  const done = await host.nextBytes();
  expect(done[0]).toBe(0x05);
  expect(readA8(done, 1)).toBe(id);
  expect((await guest.nextBytes())[0]).toBe(0xfe);
  expect((await guest.closed).code).toBe(1000);

  // bad code
  const lost = new Client(`${guestUrl}/`);
  await lost.opened;
  lost.send(cat([0, 2, 1], a8("ZZZZZZ")));
  expect((await lost.nextBytes())[0]).toBe(0xff);
  host.ws.close();
}

async function framedFlow(hostUrl: string, guestUrl: string) {
  const host = new Client(`${hostUrl}/lan/host`);
  await host.opened;
  const hosted = await host.nextJson();
  expect(hosted.type).toBe("hosted");
  const guest = new Client(`${guestUrl}/lan/join?code=${hosted.code}`);
  await guest.opened;
  guest.send(Uint8Array.from([42, 43])); // sent before join completes: must be buffered, not lost
  const open = await host.nextJson();
  expect(open.type).toBe("peer-open");
  const frame = parseHostFrame(await host.nextBytes());
  expect(frame.peerId).toBe(open.peer);
  expect([...frame.payload]).toEqual([42, 43]);
  host.send(peerFrame(open.peer, Uint8Array.from([7, 7, 7])));
  expect([...(await guest.nextBytes())]).toEqual([7, 7, 7]);
  guest.ws.close();
  const closed = await host.nextJson();
  expect(closed).toMatchObject({ type: "peer-close", peer: open.peer });

  const g2 = new Client(`${guestUrl}/lan/join?code=${hosted.code}`);
  await g2.opened;
  await host.nextJson(); // peer-open
  host.ws.close();
  expect((await g2.closed).code).toBe(1000);
}

// ---------- cross-instance (needs a Redis on 127.0.0.1:6390; skipped otherwise) ----------
const REDIS = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6390";
const redisUp = await (async () => {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port: Number(new URL(REDIS).port), socket: { data() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!redisUp)("relay (two instances sharing Redis)", () => {
  let a: ReturnType<typeof startRelay>;
  let b: ReturnType<typeof startRelay>;
  beforeAll(async () => {
    a = startRelay({ RELAY_PUBLIC: "1", REDIS_URL: REDIS });
    b = startRelay({ RELAY_PUBLIC: "1", REDIS_URL: REDIS });
    expect(a.relay.bus.inst).not.toBe(b.relay.bus.inst);
    expect(a.relay.bus.shared).toBe(true);
    await Bun.sleep(200);
  });
  afterAll(() => {
    a.server.stop(true);
    b.server.stop(true);
  });
  test("legacy LAN: host on A, guest on B", async () => {
    await legacyFlow(a.url, b.url);
  });
  test("framed LAN: host on A, guest on B", async () => {
    await framedFlow(a.url, b.url);
  });
});
