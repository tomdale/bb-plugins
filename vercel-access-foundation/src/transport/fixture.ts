import { EventEmitter } from "node:events";
import { TextDecoder } from "node:util";
import { binding, LIMITS, type Frame } from "./protocol.ts";
import { StreamCancelled, type Session } from "./session.ts";
import { streamKey } from "./ledger.ts";
interface FixtureStream { open: Extract<Frame, { type: "open" }>; chunks: Buffer[] }

// This fixture has no sockets, URL constructor, filesystem access, or upstream selector.
export class SyntheticFixture extends EventEmitter {
  producers = 0;
  get mutations() { return this.state.mutations; }
  readonly streams = new Map<string, FixtureStream>();
  constructor(readonly session: Session, readonly state = { mutations: 0 }) {
    super();
    session.once("closed", () => this.streams.clear());
    session.on("terminal", (frame: Frame) => this.streams.delete(streamKey(frame)));
    session.receive = async (frame) => {
      const key = streamKey(frame);
      if (frame.type === "open") {
        this.streams.set(key, { open: frame, chunks: [] });
        await session.send({ ...binding(frame), type: "start", status: 200, protocol: frame.mode === "ws" ? "fixture.v1" : "" });
        this.emit("opened", frame);
        return;
      }
      if (frame.type === "cancel") { this.streams.delete(key); this.emit("cancelled", frame); return; }
      // A WebSocket close is terminal at the session layer before fixture dispatch.
      if (frame.type === "end" && !this.streams.has(key)) { this.emit("peer-close", frame); return; }
      const stream = this.streams.get(key);
      if (!stream) throw new Error("Fixture state");
      if (frame.type === "data") {
        const bytes = Buffer.from(frame.bytes, "base64");
        if (stream.open.mode === "ws") {
          if (!frame.binary) new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          // Credit is returned only after the consumer drains the echo, bounding both directions.
          this.#produce(async () => { await session.data(frame, bytes, frame.binary); await session.ack(frame); });
        } else { stream.chunks.push(bytes); await session.ack(frame); }
      } else if (frame.type === "end") {
        if (stream.open.mode === "ws") { this.streams.delete(key); return; }
        this.#produce(() => this.#respond(stream));
      }
    };
  }
  #produce(run: () => Promise<void>): void {
    this.producers++;
    void run().catch((error) => {
      if (!(error instanceof StreamCancelled)) this.session.close();
    }).finally(() => { this.producers--; this.emit("producer-settled"); });
  }
  async #respond(stream: FixtureStream): Promise<void> {
    const { open } = stream, key = streamKey(open);
    if (open.target === "/v1/fixture/hold") return;
    let output: Buffer;
    if (open.target === "/v1/fixture/bytes") output = Buffer.alloc(512 * 1024, 0xa5);
    else if (open.target === "/v1/fixture/echo") output = Buffer.concat(stream.chunks);
    else if (open.target === "/v1/fixture/mutate") {
      this.state.mutations++;
      this.emit("mutated");
      output = Buffer.from(String(this.mutations));
    } else output = Buffer.from("synthetic probe\n");
    stream.chunks = [];
    for (let offset = 0; offset < output.length; offset += LIMITS.chunk) {
      if (!this.streams.has(key)) return;
      await this.session.data(open, output.subarray(offset, offset + LIMITS.chunk));
    }
    if (this.streams.has(key)) { await this.session.end(open); this.streams.delete(key); }
  }
}
