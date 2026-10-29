import { setTimeout as delay } from "node:timers/promises";
import { Authority } from "./authority.ts";
import { SyntheticFixture } from "./fixture.ts";
import { Session } from "./session.ts";
import { connect, type ClientOptions } from "./wire.ts";

export type Wait = (ms: number, signal: AbortSignal) => Promise<void>;
export class Connector {
  session: Session | undefined;
  fixture: SyntheticFixture | undefined;
  readonly fixtureState = { mutations: 0 };
  constructor(readonly options: Omit<ClientOptions, "role" | "signal">, readonly authority: Authority) {}
  async open(signal?: AbortSignal): Promise<Session> {
    this.session?.close();
    const connection = await connect({ ...this.options, role: "connector", signal });
    const session = new Session(connection, "connector", this.authority, this.options.automaticTick);
    this.session = session;
    this.fixture = new SyntheticFixture(session, this.fixtureState);
    return session;
  }
  async run(signal: AbortSignal, wait: Wait = async (ms, signal) => { await delay(ms, undefined, { signal }); }, random = Math.random): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const session = await this.open(signal);
        failures = 0;
        await new Promise<void>((resolve) => { if (session.connection.wire.closed) resolve(); else session.once("closed", resolve); });
      } catch { /* Reconnect establishes a fresh epoch; application streams are never retried. */ }
      if (signal.aborted) break;
      const ceiling = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
      const ms = Math.min(30_000, Math.max(1000, Math.floor(ceiling * (0.5 + random() * 0.5))));
      try { await wait(ms, signal); } catch { if (!signal.aborted) throw new Error("Reconnect scheduler failed"); }
    }
    this.close();
  }
  close() { this.session?.close(); }
}
