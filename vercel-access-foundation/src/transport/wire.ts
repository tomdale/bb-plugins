import { EventEmitter } from "node:events";
import type { KeyObject } from "node:crypto";
import WebSocket from "ws";
import type { RelayIdentity } from "../authorization.ts";
import { LIMITS, seal, unseal, type Payload, type Keys, type Role, localRelay, fresh } from "./protocol.ts";

export class Wire extends EventEmitter {
  queued = 0;
  peakQueue = 0;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #lastPong: number;
  #lastPing: number;
  #handshakeDeadline: number | null;
  #timer: ReturnType<typeof setInterval> | undefined;
  handler: (payload: Payload, raw: string) => Promise<void> = async () => { throw new Error("Not ready"); };
  constructor(readonly socket: WebSocket, readonly ownKey: KeyObject, public peerKey: KeyObject,
    readonly identity: RelayIdentity, readonly now: () => number = Date.now, automaticTick = true) {
    super();
    this.#lastPong = this.#lastPing = now();
    this.#handshakeDeadline = now() + LIMITS.ttl;
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
    socket.on("pong", () => { this.#lastPong = now(); });
    socket.on("message", (raw, binary) => {
      const size = Buffer.byteLength(raw as Buffer);
      if (binary || size > LIMITS.frame || this.queued + size > LIMITS.queue) { this.close(); return; }
      this.queued += size; this.peakQueue = Math.max(this.peakQueue, this.queued);
      this.#tail = this.#tail.then(async () => {
        if (!this.#closed) await this.handler(unseal(raw as Buffer, this.peerKey, this.identity), raw.toString());
      }).catch(() => this.close()).finally(() => { this.queued -= size; });
    });
    if (automaticTick) this.#timer = setInterval(() => this.tick(), 1000);
  }
  get closed() { return this.#closed; }
  async idle(): Promise<void> { await this.#tail; }
  ready() { this.#handshakeDeadline = null; }
  tick(): void {
    if (this.#handshakeDeadline !== null && this.now() >= this.#handshakeDeadline || this.now() - this.#lastPong >= LIMITS.timeout) { this.close(); return; }
    if (this.now() - this.#lastPing >= LIMITS.heartbeat && this.socket.readyState === WebSocket.OPEN) {
      this.#lastPing = this.now(); this.socket.ping();
    }
  }
  async send(payload: Payload): Promise<void> { await this.sendRaw(seal(payload, this.ownKey)); }
  async sendRaw(text: string): Promise<void> {
    if (this.#closed || this.socket.readyState !== WebSocket.OPEN || Buffer.byteLength(text) > LIMITS.frame ||
        this.socket.bufferedAmount + Buffer.byteLength(text) > LIMITS.queue) { this.close(); throw new Error("Wire budget/closed"); }
    await new Promise<void>((resolve, reject) => this.socket.send(text, (error) => error ? reject(error) : resolve()));
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.socket.terminate();
    this.emit("closed");
  }
}
export interface ClientOptions {
  url: string; identity: RelayIdentity; role: Role; privateKey: KeyObject; keys: Keys;
  now?: () => number; automaticTick?: boolean; signal?: AbortSignal;
}
export interface ClientConnection { wire: Wire; epoch: string; connectorEpoch: string }
export async function connect(options: ClientOptions): Promise<ClientConnection> {
  options.signal?.throwIfAborted();
  localRelay(options.url);
  const socket = new WebSocket(options.url, { headers: { "x-fixture-role": options.role },
    maxPayload: LIMITS.frame, maxFragments: 64, maxBufferedChunks: 64, perMessageDeflate: false, handshakeTimeout: LIMITS.ttl });
  const epoch = fresh();
  const wire = new Wire(socket, options.privateKey, options.keys.relay, options.identity, options.now, options.automaticTick);
  const abort = () => wire.close();
  return await new Promise<ClientConnection>((resolve, reject) => {
    let challenge: string | undefined;
    const fail = () => { options.signal?.removeEventListener("abort", abort); reject(new Error("Relay handshake closed")); };
    wire.once("closed", fail);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { wire.close(); return; }
    wire.handler = async (payload) => {
      if (payload.type === "challenge" && !challenge) {
        challenge = payload.challenge;
        await wire.send({ ...options.identity, type: "hello", role: options.role, epoch, challenge });
      } else if (payload.type === "ready" && payload.epoch === epoch && payload.challenge === challenge &&
          (options.role !== "connector" || payload.connectorEpoch === epoch)) {
        wire.removeListener("closed", fail);
        // Stream signatures come from the other endpoint, never the relay's handshake key.
        wire.ready();
        wire.peerKey = options.keys[options.role === "gateway" ? "connector" : "gateway"];
        wire.handler = async () => { throw new Error("Stream handler not installed"); };
        wire.once("closed", () => options.signal?.removeEventListener("abort", abort));
        resolve({ wire, epoch, connectorEpoch: payload.connectorEpoch });
      } else throw new Error("Handshake role/state");
    };
  });
}
