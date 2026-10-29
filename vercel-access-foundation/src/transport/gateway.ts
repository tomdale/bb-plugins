import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Authority, type Lease } from "./authority.ts";
import { Session, StreamCancelled } from "./session.ts";
import { connect, type ClientOptions } from "./wire.ts";
import { binding, fresh, LIMITS, route, safeHeaders, type Frame } from "./protocol.ts";

interface ClientStream {
  open: Extract<Frame, { type: "open" }>;
  response?: ServerResponse;
  ws?: WebSocket;
}
export class Gateway {
  readonly server: Server;
  readonly streams = new Map<string, ClientStream>();
  session: Session | undefined;
  url = "";
  #wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.chunk, perMessageDeflate: false,
    maxFragments: 64, maxBufferedChunks: 64, handleProtocols: (protocols) => protocols.has("fixture.v1") ? "fixture.v1" : false });
  constructor(readonly options: Omit<ClientOptions, "role">, readonly authority: Authority) {
    this.server = createServer((req, res) => { void this.#http(req, res); });
    this.server.maxConnections = 32;
    this.server.requestTimeout = LIMITS.timeout;
    this.server.headersTimeout = LIMITS.ttl;
    this.server.setTimeout(LIMITS.timeout, (socket) => socket.destroy());
    this.server.on("upgrade", (req, socket, head) => {
      try {
        const lease = this.#authenticate(req, "ws");
        if (this.#wss.clients.size >= LIMITS.streams || req.headers["sec-websocket-protocol"] !== "fixture.v1" || !this.session || this.session.connection.wire.closed) throw new Error("WebSocket unavailable");
        this.#wss.handleUpgrade(req, socket, head, (ws) => {
          const open = this.#open(req, lease, "ws"), stream: ClientStream = { open, ws };
          this.streams.set(open.id, stream);
          let queued = 0, closed = false;
          let tail = this.session!.send(open);
          ws.on("error", () => ws.terminate());
          ws.on("message", (raw, binary) => {
            const data = Buffer.from(raw as Buffer);
            queued += data.length; ws.pause();
            if (queued > LIMITS.queue) { ws.terminate(); return; }
            tail = tail.then(async () => { await this.session!.data(open, data, binary); }).finally(() => {
              queued -= data.length; if (!closed && queued === 0) ws.resume();
            });
            void tail.catch((error) => { if (!(error instanceof StreamCancelled)) ws.terminate(); });
          });
          ws.on("close", (code, reason) => {
            closed = true;
            tail = tail.then(async () => { await this.session?.end(open, code === 1006 || code === 1005 ? 1001 : code, reason.toString()); });
            void tail.catch((error) => { if (!(error instanceof StreamCancelled)) this.session?.close(); }).finally(() => this.streams.delete(open.id));
          });
          void tail.catch((error) => { if (!(error instanceof StreamCancelled)) ws.terminate(); });
        });
      } catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
    });
  }
  #authenticate(req: IncomingMessage, mode: "http" | "ws"): Lease {
    safeHeaders(new Headers(req.headers as Record<string, string>));
    // The Node HTTP parser rejects ambiguous request framing. Reject duplicated authority inputs too.
    const names = req.rawHeaders.filter((_, i) => i % 2 === 0).map((name) => name.toLowerCase());
    if (["x-fixture-access", "host", "authorization"].some((name) => names.filter((x) => x === name).length > 1)) throw new Error("Duplicate credential/host");
    if (req.headers.host !== new URL(this.url).host) throw new Error("Gateway Host");
    const token = req.headers["x-fixture-access"];
    const lease = this.authority.authenticate(typeof token === "string" ? token : undefined);
    const length = mode === "ws" ? null : Number(req.headers["content-length"] ?? 0);
    if (req.method === "POST" && req.headers["content-length"] === undefined) throw new Error("Explicit length required");
    route(req.method ?? "", req.url ?? "", mode, length);
    return lease;
  }
  #open(req: IncomingMessage, lease: Lease, mode: "http" | "ws"): Extract<Frame, { type: "open" }> {
    const session = this.session;
    if (!session || session.connection.wire.closed || session.ledger.streams.size >= LIMITS.streams) throw new Error("Unavailable/stream budget");
    const now = this.authority.now();
    return { ...this.options.identity, gatewayEpoch: session.connection.epoch, connectorEpoch: session.connection.connectorEpoch,
      id: fresh(), type: "open", grantId: lease.id, hostId: lease.hostId, acquisitionEpoch: lease.epoch,
      scope: "transport:probe", method: req.method as "GET" | "POST", target: req.url!, mode,
      body: "signed-ordered-v1", length: mode === "ws" ? null : Number(req.headers["content-length"] ?? 0),
      issuedAt: now, deadline: Math.min(lease.expiresAt, now + LIMITS.ttl) };
  }
  async #http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let stream: ClientStream | undefined;
    try {
      const lease = this.#authenticate(req, "http"), open = this.#open(req, lease, "http");
      stream = { open, response: res }; this.streams.set(open.id, stream);
      res.once("close", () => {
        if (!res.writableFinished && this.session?.ledger.streams.has(`${open.gatewayEpoch}/${open.id}`)) {
          void this.session.send({ ...binding(open), type: "cancel" }).catch(() => this.session?.close());
        }
        this.streams.delete(open.id);
      });
      await this.session!.send(open);
      for await (const bytes of req) {
        const chunk = Buffer.from(bytes);
        for (let offset = 0; offset < chunk.length; offset += LIMITS.chunk) await this.session!.data(open, chunk.subarray(offset, offset + LIMITS.chunk));
      }
      await this.session!.end(open);
    } catch {
      if (stream) {
        this.streams.delete(stream.open.id);
        if (this.session?.ledger.streams.has(`${stream.open.gatewayEpoch}/${stream.open.id}`)) {
          void this.session.send({ ...binding(stream.open), type: "cancel" }).catch(() => this.session?.close());
        }
      }
      if (res.headersSent) res.destroy(); else { res.writeHead(403, { "cache-control": "no-store" }); res.end(); }
    }
  }
  async #retire(session: Session, frame: Frame): Promise<void> {
    if (session.ledger.streams.has(`${frame.gatewayEpoch}/${frame.id}`)) {
      await session.send({ ...binding(frame), type: "cancel" });
    }
    const stream = this.streams.get(frame.id);
    if (stream?.ws?.readyState === WebSocket.OPEN) stream.ws.close(1001, "stream retired");
    stream?.response?.destroy();
    this.streams.delete(frame.id);
  }
  async attach(): Promise<void> {
    this.session?.close();
    const connection = await connect({ ...this.options, role: "gateway" });
    const session = new Session(connection, "gateway", this.authority, this.options.automaticTick);
    this.session = session;
    session.once("closed", () => {
      for (const stream of this.streams.values()) { stream.response?.destroy(); stream.ws?.terminate(); }
      this.streams.clear();
    });
    session.receive = async (frame) => {
      const stream = this.streams.get(frame.id);
      // Session validation rejects unknown streams before dispatch. A verified live
      // stream may merely have lost its consumer while signed data was in flight.
      if (!stream || frame.type === "data" && stream.ws && stream.ws.readyState !== WebSocket.OPEN || stream.response?.destroyed) {
        await this.#retire(session, frame); return;
      }
      if (frame.type === "start") {
        stream.response?.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
        stream.response?.flushHeaders();
      } else if (frame.type === "data") {
        const bytes = Buffer.from(frame.bytes, "base64");
        try {
          if (stream.ws) {
            const ws = stream.ws;
            if (ws.bufferedAmount + bytes.length > LIMITS.queue) throw new Error("Client queue budget");
            await new Promise<void>((resolve, reject) => ws.send(bytes, { binary: frame.binary }, (error) => error ? reject(error) : resolve()));
          } else {
            const response = stream.response!;
            if (!response.write(bytes)) await new Promise<void>((resolve, reject) => {
              const done = () => { cleanup(); resolve(); }, gone = () => { cleanup(); reject(new Error("Client gone")); };
              const cleanup = () => { response.off("drain", done); response.off("close", gone); };
              response.once("drain", done); response.once("close", gone);
            });
          }
        } catch { await this.#retire(session, frame); return; }
        try { await session.ack(frame); }
        catch (error) { if (!(error instanceof StreamCancelled)) throw error; }
      } else if (frame.type === "end") {
        stream.response?.end(); stream.ws?.close(frame.code, frame.reason); this.streams.delete(frame.id);
      } else if (frame.type === "cancel") {
        stream.response?.destroy(); stream.ws?.terminate(); this.streams.delete(frame.id);
      } else throw new Error("Gateway direction");
    };
  }
  async listen(): Promise<string> {
    await this.attach();
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this.url;
  }
  async close(): Promise<void> {
    this.session?.close();
    for (const ws of this.#wss.clients) ws.terminate();
    this.server.closeAllConnections();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
