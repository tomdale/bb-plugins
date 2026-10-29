import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { AdmissionLeases } from "./grants.ts";
import { ACCESS_HEADER, admitRequest, routeCategory, DAEMON_PROTOCOL, MAX_BODY, MAX_CONNECTIONS, MAX_RESPONSE, TESTED_CORE } from "./policy.ts";
import { AdmissionDenied, AdmissionDiagnostics, methodCategories, type AdmissionSnapshot, type MethodCategory } from "./diagnostics.ts";

function loopback(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.port) throw new Error("Expected the supported BB IPv4 loopback URL");
  return url;
}

export async function checkCore(baseUrl: string): Promise<void> {
  const url = loopback(baseUrl);
  const version = await new Promise<unknown>((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path: "/install/version", agent: false, timeout: 5000 }, res => {
      let data = "";
      res.on("data", chunk => { data += chunk; if (data.length > 4096) res.destroy(new Error("Version response too large")); });
      res.on("error", reject);
      res.on("end", () => { try { if (res.statusCode !== 200) throw new Error("Unsupported core"); resolve(JSON.parse(data)); } catch { reject(new Error("Unsupported core")); } });
    });
    req.on("error", () => reject(new Error("Cannot check BB machine protocol")));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
  if (!version || typeof version !== "object" || !("version" in version) || !("protocolVersion" in version) ||
      version.version !== TESTED_CORE.version || version.protocolVersion !== TESTED_CORE.protocolVersion) throw new Error("BB release has not passed bridge conformance");
}

function denied(res: ServerResponse, status = 403) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store", connection: "close" });
  res.end("Machine bridge denied request\n");
}

/**
 * A fixed-destination, machine-route HTTP/WS bridge. Only its loopback listener
 * may be attached to a separately authenticated tunnel. It is not remote-owner
 * ingress: core sees loopback, so this allowlist is the owner isolation boundary.
 */
export async function openBridge(options: { baseUrl: string; leases: AdmissionLeases; port?: number; onRejection?: (snapshot: AdmissionSnapshot) => void }) {
  await checkCore(options.baseUrl);
  return openSurface({ upstream: loopback(options.baseUrl), leases: options.leases, port: options.port, bind: "127.0.0.1", onRejection: options.onRejection });
}

/**
 * A relay's public HTTP/WS adapter. The destination is its one loopback reverse
 * listener, never BB's port or a request-selected address. Platform forwarding
 * metadata is discarded, and Host is rebuilt for the laptop bridge.
 */
export async function openRelayAdapter(options: {
  reversePort: number; bridgePort: number; publicAuthority: string;
  port?: number; bind?: "127.0.0.1" | "0.0.0.0";
  onRejection?: (snapshot: AdmissionSnapshot) => void;
  diagnostics?: AdmissionDiagnostics;
  connector?: Pick<Awaited<ReturnType<typeof import("./tunnel.ts").openTunnelRelay>>, "upgrade">;
}) {
  for (const port of [options.reversePort, options.bridgePort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid fixed relay port");
  if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(options.publicAuthority)) throw new Error("Invalid fixed public authority");
  return openSurface({
    upstream: new URL(`http://127.0.0.1:${options.reversePort}`), leases: null,
    authority: options.publicAuthority, upstreamAuthority: `127.0.0.1:${options.bridgePort}`,
    port: options.port, bind: options.bind ?? "127.0.0.1", connector: options.connector, onRejection: options.onRejection, diagnostics: options.diagnostics,
  });
}

async function openSurface(options: {
  upstream: URL; leases: AdmissionLeases | null; port?: number; bind: "127.0.0.1" | "0.0.0.0";
  authority?: string; upstreamAuthority?: string;
  onRejection?: (snapshot: AdmissionSnapshot) => void;
  diagnostics?: AdmissionDiagnostics;
  connector?: Pick<Awaited<ReturnType<typeof import("./tunnel.ts").openTunnelRelay>>, "upgrade">;
}) {
  const { upstream, leases } = options;
  const upstreamAuthority = options.upstreamAuthority ?? upstream.host;
  const sockets = new Set<Socket>();
  const admitted = new Map<Duplex, string>();
  const tasks = new Set<() => void>();
  let closing = false;
  let authority = "";
  let inFlight = 0;
  const diagnostics = options.diagnostics ?? new AdmissionDiagnostics(options.onRejection);
  const rejected = (req: IncomingMessage, error: unknown, connector = false) => diagnostics.record({
    reason: error instanceof AdmissionDenied ? error.reason : "policy",
    headerNames: error instanceof AdmissionDenied ? error.headerNames : [],
    route: connector ? "connector" : routeCategory(req.method ?? "", req.url ?? ""),
    method: methodCategories.includes(req.method as MethodCategory) ? req.method as MethodCategory : "OTHER",
    status: connector ? null : 403, hostMatches: req.headers.host === authority,
  });
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 1000 }, (req, res) => {
    void http(req, res);
  });
  const wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_BODY, maxFragments: 64, maxBufferedChunks: 128 });

  const revoke = leases?.onRevoke(digest => {
    for (const [socket, bound] of admitted) if (bound === digest) socket.destroy();
  }) ?? (() => {});
  const expiry = setInterval(() => leases?.expire(), 1000);
  expiry.unref();
  server.maxConnections = MAX_CONNECTIONS;
  server.maxRequestsPerSocket = 1;
  server.on("connection", socket => {
    sockets.add(socket);
    socket.setTimeout(15_000, () => { if (!admitted.has(socket)) socket.destroy(); });
    socket.on("error", () => {});
    socket.once("close", () => { sockets.delete(socket); admitted.delete(socket); });
    if (closing || sockets.size > MAX_CONNECTIONS) socket.destroy();
  });
  server.on("clientError", (_error, socket) => { socket.destroy(); });
  server.on("checkContinue", (_req, res) => denied(res));
  server.on("checkExpectation", (_req, res) => denied(res));
  server.on("connect", (_req, socket) => socket.destroy());

  function admit(req: IncomingMessage, upgrade: boolean) {
    if (closing || inFlight >= 16) throw new AdmissionDenied("capacity");
    const accepted = admitRequest(req, authority, upgrade, leases === null);
    if (leases && !leases.accepts(accepted.token)) throw new AdmissionDenied("admission");
    admitted.set(req.socket, leases ? leases.digest(accepted.token) : "relay");
    if (!leases) accepted.headers[ACCESS_HEADER] = accepted.token;
    return accepted;
  }

  async function http(req: IncomingMessage, res: ServerResponse) {
    let accepted: ReturnType<typeof admit>;
    try { accepted = admit(req, false); } catch (error) { rejected(req, error); denied(res); return; }
    inFlight++;
    let native: ReturnType<typeof request> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let bodyTimer: NodeJS.Timeout | undefined;
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(bodyTimer);
      native?.destroy();
      tasks.delete(stop);
      admitted.delete(req.socket);
      inFlight--;
    };
    tasks.add(stop);
    res.on("close", stop);
    req.on("error", () => { denied(res, 400); stop(); });
    bodyTimer = setTimeout(() => { denied(res, 408); req.destroy(); stop(); }, 15_000);
    try {
      // Complete, bounded staging prevents a truncated or ambiguous POST from
      // causing native side effects before its framing has been checked.
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > accepted.length) throw new Error("denied");
        chunks.push(Buffer.from(chunk));
      }
      if (done || closing || (leases && !leases.accepts(accepted.token)) || size !== accepted.length) throw new Error("denied");
      clearTimeout(bodyTimer);
      // Node HTTP also handles socket inactivity timeouts. A no-op socket
      // callback does not prevent it from destroying admitted async requests.
      // Keep reception bounded, then remove inactivity timing at both hops.
      req.socket.setTimeout(0);
      native = request({ hostname: upstream.hostname, port: upstream.port, method: req.method, path: accepted.target, headers: { ...accepted.headers, host: upstreamAuthority, connection: "close" }, agent: false }, response => {
        const status = response.statusCode ?? 502;
        if (status >= 300 && status < 400 && status !== 304) { response.destroy(); denied(res, 502); stop(); return; }
        const headers: Record<string, string> = { "cache-control": "no-store", connection: "close", "x-content-type-options": "nosniff" };
        for (const name of ["content-type", "content-length", "x-bb-artifact-sha256", "etag"]) {
          const value = response.headers[name];
          if (typeof value === "string") headers[name] = value;
        }
        res.writeHead(status, headers);
        let received = 0;
        response.on("data", chunk => { received += chunk.length; if (received > MAX_RESPONSE) { response.destroy(); res.destroy(); } });
        response.on("error", () => { res.destroy(); stop(); });
        response.pipe(res);
      });
      native.on("error", () => { denied(res, 502); stop(); });
      // Native tool/interactive operations can wait for user input. Bound only
      // TCP establishment here; ongoing work ends on native completion,
      // consumer cancellation, admission revocation, or service disposal.
      timer = setTimeout(() => { denied(res, 504); stop(); }, 5000);
      native.once("socket", socket => {
        if (!socket.connecting) clearTimeout(timer);
        else socket.once("connect", () => clearTimeout(timer));
      });
      native.end(Buffer.concat(chunks));
    } catch { denied(res, 400); stop(); }
  }

  server.on("upgrade", (req, socket, head) => {
    if (options.connector && req.url === "/machine-connector") {
      if (req.headers.host !== authority) { rejected(req, new AdmissionDenied("host-mismatch", ["host"]), true); socket.destroy(); return; }
      options.connector.upgrade(req, socket, head);
      return;
    }
    let accepted: ReturnType<typeof admit>;
    try { accepted = admit(req, true); } catch (error) { rejected(req, error); socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    inFlight++;
    let remote: WebSocket | undefined;
    let done = false;
    let closeTimer: NodeJS.Timeout | undefined;
    const propagateClose = (to: WebSocket | undefined, code: number, reason: Buffer) => {
      if (done) return;
      if (!to || code === 1006 || code === 1005 || code === 1015) { stop(); return; }
      if (to.readyState === WebSocket.OPEN) to.close(code, reason.toString());
      if (native.readyState === WebSocket.CLOSED && remote?.readyState === WebSocket.CLOSED) { stop(); return; }
      closeTimer ??= setTimeout(stop, 2000);
    };
    const native = new WebSocket(`ws://${upstream.host}${accepted.target}`, [DAEMON_PROTOCOL], {
      headers: { ...accepted.headers, host: upstreamAuthority }, perMessageDeflate: false, maxPayload: MAX_BODY,
      maxFragments: 64, maxBufferedChunks: 128, handshakeTimeout: 5000, followRedirects: false,
    });
    const stop = () => {
      if (done) return;
      done = true;
      clearTimeout(closeTimer);
      native.terminate();
      remote?.terminate();
      socket.destroy();
      tasks.delete(stop);
      admitted.delete(socket);
      inFlight--;
    };
    tasks.add(stop);
    socket.once("close", stop);
    native.on("error", stop);
    native.on("unexpected-response", (_request, response) => { response.destroy(); stop(); });
    native.on("close", (code, reason) => propagateClose(remote, code, reason));
    native.on("open", () => {
      if (done || closing || (leases && !leases.accepts(accepted.token))) { stop(); return; }
      try {
        wsServer.handleUpgrade(req, socket, head, peer => {
          remote = peer;
          socket.off("close", stop);
          peer.on("error", stop);
          peer.on("close", (code, reason) => propagateClose(native, code, reason));
          const forward = (from: WebSocket, to: WebSocket) => from.on("message", (data, binary) => {
            const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
            if (done || to.readyState !== WebSocket.OPEN || to.bufferedAmount + bytes.length > MAX_BODY) { stop(); return; }
            from.pause();
            to.send(bytes, { binary }, error => { if (error) stop(); else if (!done) from.resume(); });
          });
          forward(peer, native);
          forward(native, peer);
        });
      } catch { stop(); }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.bind, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { clearInterval(expiry); revoke(); wsServer.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No bridge address");
  const localAuthority = `127.0.0.1:${address.port}`;
  authority = options.authority ?? localAuthority;
  return {
    url: `http://${localAuthority}`,
    diagnostics: () => diagnostics.snapshot(),
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(expiry);
      revoke();
      for (const stop of [...tasks]) stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      wsServer.close();
    },
  };
}
