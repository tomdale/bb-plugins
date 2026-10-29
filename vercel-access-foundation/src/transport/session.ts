import { EventEmitter } from "node:events";
import type { Authority } from "./authority.ts";
import { Ledger, streamKey } from "./ledger.ts";
import { binding, isFrame, LIMITS, type Frame, type Binding, type Role } from "./protocol.ts";
import type { ClientConnection } from "./wire.ts";

export class StreamCancelled extends Error {
  constructor() { super("Stream cancelled"); }
}
export class Session extends EventEmitter {
  readonly ledger: Ledger;
  #credits = new Map<string, { seq: number; resolve(): void; reject(error: Error): void }>();
  #unsub: () => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  receive: (frame: Frame) => Promise<void> = async () => {};
  constructor(readonly connection: ClientConnection, readonly role: Role, readonly authority: Authority, automaticTick = true) {
    super(); this.ledger = new Ledger(authority);
    this.#unsub = authority.onChange(() => this.sweep());
    if (automaticTick) this.#timer = setInterval(() => this.sweep(), 1000);
    connection.wire.once("closed", () => {
      this.#unsub(); if (this.#timer) clearInterval(this.#timer);
      for (const credit of this.#credits.values()) credit.reject(new StreamCancelled());
      this.#credits.clear(); this.ledger.streams.clear(); this.emit("closed");
    });
    connection.wire.handler = async (p) => {
      if (!isFrame(p) || p.connectorEpoch !== connection.connectorEpoch || role === "gateway" && p.gatewayEpoch !== connection.epoch) throw new Error("Endpoint epoch");
      if (!this.ledger.accept(p, role === "gateway" ? "connector" : "gateway")) return;
      if (!this.ledger.streams.has(streamKey(p))) this.#terminal(p);
      if (p.type === "ack") {
        const credit = this.#credits.get(streamKey(p));
        if (!credit || credit.seq !== p.seq) throw new Error("Credit state");
        this.#credits.delete(streamKey(p)); credit.resolve();
      } else await this.receive(p);
    };
  }
  get pendingCredits() { return this.#credits.size; }
  #terminal(frame: Frame): void {
    const key = streamKey(frame), credit = this.#credits.get(key);
    this.#credits.delete(key);
    credit?.reject(new StreamCancelled());
    this.emit("terminal", frame);
  }
  async send(frame: Frame): Promise<void> {
    if (this.connection.wire.closed) throw new StreamCancelled();
    if (!this.ledger.accept(frame, this.role)) throw new StreamCancelled();
    if (!this.ledger.streams.has(streamKey(frame))) this.#terminal(frame);
    await this.connection.wire.send(frame);
  }
  async data(b: Binding, bytes: Buffer, binary = true): Promise<void> {
    if (bytes.length > LIMITS.chunk) throw new Error("Chunk budget");
    const state = this.ledger.streams.get(`${b.gatewayEpoch}/${b.id}`);
    if (!state) throw new StreamCancelled();
    if (this.#credits.has(`${b.gatewayEpoch}/${b.id}`)) throw new Error("Outstanding credit");
    const seq = state[this.role === "gateway" ? "requestSeq" : "responseSeq"];
    const acknowledged = new Promise<void>((resolve, reject) => this.#credits.set(`${b.gatewayEpoch}/${b.id}`, { seq, resolve, reject }));
    // Register credit before sending; even a synchronous loopback peer cannot race the ACK.
    try {
      await this.send({ ...binding(b), type: "data", seq, bytes: bytes.toString("base64"), binary });
    } catch (error) {
      this.#credits.get(`${b.gatewayEpoch}/${b.id}`)?.reject(error as Error);
      this.#credits.delete(`${b.gatewayEpoch}/${b.id}`);
    }
    await acknowledged;
  }
  async ack(f: Extract<Frame, { type: "data" }>) { await this.send({ ...binding(f), type: "ack", seq: f.seq }); }
  async end(b: Binding, code = 1000, reason = ""): Promise<void> {
    const state = this.ledger.streams.get(`${b.gatewayEpoch}/${b.id}`);
    if (!state) return;
    await this.send({ ...binding(b), type: "end", count: state[this.role === "gateway" ? "request" : "response"], code, reason });
  }
  sweep(): void { if (this.ledger.invalid().length) this.close(); }
  close() { this.connection.wire.close(); }
}
