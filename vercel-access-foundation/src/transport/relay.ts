import { createServer, type Server } from "node:http";
import type { KeyObject } from "node:crypto";
import { WebSocketServer } from "ws";
import type { RelayIdentity } from "../authorization.ts";
import { LIMITS, fresh, isFrame, safeHeaders, type Keys, type Role } from "./protocol.ts";
import { Authority } from "./authority.ts";
import { Ledger } from "./ledger.ts";
import { Wire } from "./wire.ts";
import { AtomicFile } from "./persistence.ts";

export interface FenceRecord { generation: number; boot: string; connectorEpoch: string | null }
export interface FenceStorage { load(): Promise<FenceRecord | null>; save(value: FenceRecord): Promise<void> }
export class MemoryFenceStorage implements FenceStorage {
  state: FenceRecord | null = null;
  async load() { return structuredClone(this.state); }
  async save(value: FenceRecord) { this.state = structuredClone(value); }
}
export class FileFenceStorage extends AtomicFile<FenceRecord | null> implements FenceStorage {
  constructor(path: string) { super(path, null); }
}
// One serialized controller owns this local fixture's fencing store.
export class LocalFence {
  #tail: Promise<unknown> = Promise.resolve();
  current: FenceRecord | null = null;
  #listeners = new Set<() => void>();
  constructor(readonly storage: FenceStorage) {}
  subscribe(fn: () => void) { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; }
  claim(generation: number, boot: string, connectorEpoch: string | null = null): Promise<void> {
    const next = this.#tail.then(async () => {
      const saved = await this.storage.load();
      if (!Number.isSafeInteger(generation) || generation < 1 || saved &&
          (!Number.isSafeInteger(saved.generation) || saved.generation < 1 || typeof saved.boot !== "string" ||
          saved.connectorEpoch !== null && typeof saved.connectorEpoch !== "string")) throw new Error("Fence format");
      if (saved && (generation < saved.generation || connectorEpoch !== null && (saved.boot !== boot || saved.generation !== generation))) throw new Error("Stale relay fence");
      const value = { generation, boot, connectorEpoch };
      await this.storage.save(value);
      this.current = value;
      for (const fn of this.#listeners) fn();
    });
    this.#tail = next.catch(() => {});
    return next;
  }
}
export class Relay {
  readonly server: Server;
  readonly sockets = new Set<Wire>();
  readonly ledger: Ledger;
  readonly boot = fresh();
  #connector: { wire: Wire; epoch: string } | undefined;
  #gateways = new Map<string, Wire>();
  #unsub: (() => void)[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  url = "";
  constructor(readonly identity: RelayIdentity, readonly privateKey: KeyObject, readonly keys: Keys,
    readonly authority: Authority, readonly fence: LocalFence, readonly automaticTick = true) {
    this.ledger = new Ledger(authority);
    this.server = createServer((_req, res) => { res.writeHead(403, { "cache-control": "no-store" }); res.end(); });
    this.server.maxConnections = 32;
    this.server.headersTimeout = LIMITS.ttl;
    this.server.requestTimeout = LIMITS.timeout;
    this.server.setTimeout(LIMITS.timeout, (socket) => socket.destroy());
    const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.frame, perMessageDeflate: false,
      maxFragments: 64, maxBufferedChunks: 64 });
    this.server.on("upgrade", (req, socket, head) => {
      try {
        safeHeaders(new Headers(req.headers as Record<string, string>));
        const role = req.headers["x-fixture-role"];
        if (req.headers.host !== `127.0.0.1:${(this.server.address() as { port: number }).port}` || req.url !== "/tunnel" || !["gateway", "connector"].includes(role as string) || this.sockets.size >= 32 ||
            this.fence.current?.boot !== this.boot) throw new Error("Relay role/origin");
        wss.handleUpgrade(req, socket, head, (ws) => {
          const wire = new Wire(ws, this.privateKey, this.keys[role as Role], this.identity, authority.now, automaticTick);
          this.sockets.add(wire);
          const challenge = fresh(), createdAt = authority.now();
          let epoch: string | undefined;
          wire.once("closed", () => {
            this.sockets.delete(wire);
            if (this.#connector?.wire === wire) {
              this.#connector = undefined;
              for (const gateway of this.#gateways.values()) gateway.close();
              this.ledger.streams.clear();
            }
            if (epoch && this.#gateways.get(epoch) === wire) {
              this.#gateways.delete(epoch);
              // Closing the connector prevents orphan streams when a gateway disappears.
              if ([...this.ledger.streams.values()].some((s) => s.open.gatewayEpoch === epoch)) this.#connector?.wire.close();
            }
          });
          wire.handler = async (p, raw) => {
            if (!epoch) {
              if (p.type !== "hello" || p.role !== role || p.challenge !== challenge || authority.now() - createdAt > LIMITS.ttl) throw new Error("Relay handshake");
              if (role === "connector") {
                await fence.claim(identity.generation, this.boot, p.epoch);
                this.#connector?.wire.close();
                this.#connector = { wire, epoch: p.epoch };
              } else {
                if (!this.#connector || this.#gateways.has(p.epoch)) throw new Error("No connector/epoch reuse");
                this.#gateways.set(p.epoch, wire);
              }
              epoch = p.epoch;
              wire.ready();
              await wire.send({ ...identity, type: "ready", epoch, connectorEpoch: this.#connector!.epoch, challenge });
              return;
            }
            if (!isFrame(p) || !this.#connector || p.connectorEpoch !== this.#connector.epoch ||
                (role === "gateway" ? p.gatewayEpoch !== epoch : this.#connector.wire !== wire)) throw new Error("Relay stream epoch/role");
            if (!this.ledger.accept(p, role as Role)) return;
            const destination = role === "gateway" ? this.#connector.wire : this.#gateways.get(p.gatewayEpoch);
            if (!destination) throw new Error("Gone gateway");
            await destination.sendRaw(raw);
          };
          void wire.send({ ...identity, type: "challenge", challenge }).catch(() => wire.close());
        });
      } catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
    });
    this.#unsub.push(authority.onChange(() => this.sweep()), fence.subscribe(() => this.sweep()));
    if (automaticTick) this.#timer = setInterval(() => this.sweep(), 1000);
  }
  async listen(): Promise<string> {
    await this.fence.claim(this.identity.generation, this.boot);
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `ws://127.0.0.1:${(this.server.address() as { port: number }).port}/tunnel`;
    return this.url;
  }
  sweep(): void {
    const f = this.fence.current;
    if (f && (f.boot !== this.boot || f.generation !== this.identity.generation)) {
      for (const wire of this.sockets) wire.close();
    } else if (this.#connector && f?.connectorEpoch !== this.#connector.epoch || this.ledger.invalid().length) {
      this.#connector?.wire.close();
    }
  }
  async close(): Promise<void> {
    for (const unsubscribe of this.#unsub) unsubscribe();
    if (this.#timer) clearInterval(this.#timer);
    for (const socket of this.sockets) socket.close();
    this.server.closeAllConnections();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
