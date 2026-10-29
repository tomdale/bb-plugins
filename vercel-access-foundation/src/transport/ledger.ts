import { LIMITS, type Frame, type Role } from "./protocol.ts";
import type { Authority } from "./authority.ts";
export interface StreamState {
  open: Extract<Frame, { type: "open" }>;
  request: number; response: number; requestSeq: number; responseSeq: number;
  requestPending: number | null; responsePending: number | null;
  requestEnd: boolean; responseStart: boolean;
}
export const streamKey = (frame: Frame) => `${frame.gatewayEpoch}/${frame.id}`;
export class Ledger {
  readonly streams = new Map<string, StreamState>();
  readonly seen = new Set<string>();
  peakStreams = 0;
  constructor(readonly authority: Authority) {}
  accept(f: Frame, role: Role): StreamState | undefined {
    const key = streamKey(f), existing = this.streams.get(key);
    if (f.type === "open") {
      if (role !== "gateway" || existing || this.seen.has(key) || this.seen.size >= LIMITS.seen || this.streams.size >= LIMITS.streams) throw new Error("Stream/replay limit");
      this.authority.check(f);
      const state: StreamState = { open: f, request: 0, response: 0, requestSeq: 0, responseSeq: 0,
        requestPending: null, responsePending: null, requestEnd: false, responseStart: false };
      this.streams.set(key, state); this.seen.add(key); this.peakStreams = Math.max(this.peakStreams, this.streams.size);
      return state;
    }
    // A terminal stream may still have signed frames in flight. Tombstones consume the
    // existing replay budget; they never authorize another open or recreate stream state.
    if (!existing && this.seen.has(key)) return undefined;
    if (!existing || !this.authority.byId(existing.open.grantId)) throw new Error("Unknown/revoked stream");
    const state = existing;
    if (f.connectorEpoch !== state.open.connectorEpoch || f.installationId !== state.open.installationId ||
        f.relayId !== state.open.relayId || f.generation !== state.open.generation) throw new Error("Stream epoch");
    if (f.type === "cancel") { this.streams.delete(key); return state; }
    if (f.type === "start") {
      if (role !== "connector" || state.responseStart || f.protocol !== (state.open.mode === "ws" ? "fixture.v1" : "")) throw new Error("Response state");
      state.responseStart = true;
    } else if (f.type === "data") {
      const request = role === "gateway";
      if (request ? state.requestEnd : !state.responseStart) throw new Error("Data state");
      const field = request ? "request" : "response", seq = request ? "requestSeq" : "responseSeq", pending = request ? "requestPending" : "responsePending";
      if (f.seq !== state[seq] || state[pending] !== null) throw new Error("Ordered credit");
      state[field] += Buffer.from(f.bytes, "base64").length;
      if (state[field] > LIMITS.body || request && state.open.length !== null && state[field] > state.open.length) throw new Error("Stream byte budget");
      state[seq]++; state[pending] = f.seq;
    } else if (f.type === "ack") {
      const pending = role === "connector" ? "requestPending" : "responsePending";
      if (state[pending] !== f.seq) throw new Error("Unexpected credit");
      state[pending] = null;
    } else if (f.type === "end") {
      const request = role === "gateway";
      if (f.count !== state[request ? "request" : "response"] || state[request ? "requestPending" : "responsePending"] !== null ||
          request && state.requestEnd || !request && !state.responseStart ||
          request && state.open.length !== null && f.count !== state.open.length) throw new Error("Incomplete stream");
      if (request && state.open.mode === "http") state.requestEnd = true;
      else this.streams.delete(key);
    }
    return state;
  }
  invalid(): StreamState[] { return [...this.streams.values()].filter((s) => !this.authority.byId(s.open.grantId)); }
}
