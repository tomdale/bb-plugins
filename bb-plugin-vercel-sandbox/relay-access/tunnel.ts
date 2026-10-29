import { createServer, type Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { createHash, timingSafeEqual } from "node:crypto";
import ssh2 from "./ssh2-runtime.js";
import type { Connection } from "ssh2";
const { Client, Server, utils } = ssh2;
import { WebSocket, WebSocketServer, createWebSocketStream } from "ws";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { CHANNEL_LIMIT, forwardFixedBridge, forwardReverseSocket } from "./channels.ts";
import { networkReason, report, methodCategories, type AdmissionDiagnostics, type DiagnosticSink, type DiagnosticStage, type MethodCategory } from "./diagnostics.ts";

export const CONNECTOR_PATH = "/machine-connector";

export function validSignatureProof(verify: () => boolean | Error): boolean {
  try { return verify() === true; } catch { return false; }
}
function port(value: number) { if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("Invalid fixed tunnel port"); }

/**
 * Standard SSH remote forwarding over a WebSocket byte stream. The SSH peer
 * cannot choose local destinations: accepted forwarded channels always dial
 * the one loopback bridge port, never any address received from the relay.
 */
export async function startConnector(options: {
  relayUrl: string; privateKey: string; hostFingerprint: string; bridgePort: number; reversePort: number; signal?: AbortSignal; diagnostics?: DiagnosticSink;
}) {
  if (options.signal?.aborted) { report(options.diagnostics, "readiness", "closed", "cancelled"); throw new DOMException("Connector start cancelled", "AbortError"); }
  try { port(options.bridgePort); port(options.reversePort); } catch { report(options.diagnostics, "reverse", "failed", "invalid-config"); throw new Error("Invalid fixed tunnel port"); }
  let origin: URL;
  try { origin = new URL(options.relayUrl); } catch { report(options.diagnostics, "wss", "failed", "invalid-config"); throw new Error("Invalid connector configuration"); }
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      (origin.protocol !== "wss:" && !(origin.protocol === "ws:" && origin.hostname === "127.0.0.1"))) { report(options.diagnostics, "wss", "failed", "invalid-config"); throw new Error("Expected WSS control origin or isolated WS loopback origin"); }
  if (!/^[a-f0-9]{64}$/.test(options.hostFingerprint)) { report(options.diagnostics, "ssh-host", "failed", "invalid-config"); throw new Error("Expected SHA-256 SSH host key fingerprint in hex"); }
  const privateKey = utils.parseKey(options.privateKey);
  if (privateKey instanceof Error || Array.isArray(privateKey) || privateKey.isPrivateKey() !== true) {
    report(options.diagnostics, "ssh-auth", "failed", "invalid-config");
    throw new Error("Invalid dedicated connector private key");
  }
  report(options.diagnostics, "wss", "pending");
  if (origin.protocol === "wss:") report(options.diagnostics, "tls", "pending");
  let pendingStage: DiagnosticStage = "wss";
  const socket = new WebSocket(new URL(CONNECTOR_PATH, origin), {
    perMessageDeflate: false, maxPayload: 64 * 1024, maxFragments: 64, maxBufferedChunks: 128,
    handshakeTimeout: 5000, followRedirects: false, rejectUnauthorized: true,
    finishRequest: request => {
      request.once("socket", socket => {
        if (socket instanceof TLSSocket) socket.once("secureConnect", () => report(options.diagnostics, "tls", socket.authorized ? "verified" : "failed", socket.authorized ? "none" : "tls-certificate"));
      });
      request.end();
    },
  });
  const stream = createWebSocketStream(socket, { highWaterMark: 64 * 1024 });
  const ssh = new Client();
  const local = new Set<Socket>();
  let closed = false;
  let registered = false;
  let hostRejected = false;
  let disposing = false;
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  let rejectReady: ((error: Error) => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    if (options.signal?.aborted) report(options.diagnostics, "readiness", "closed", "cancelled");
    options.signal?.removeEventListener("abort", close);
    if (registered) report(options.diagnostics, "reverse", "closed", disposing ? "disposed" : options.signal?.aborted ? "cancelled" : "peer-closed");
    registered = false;
    try {
      for (const connection of local) connection.destroy();
      local.clear();
      ssh.destroy(); stream.destroy(); socket.terminate();
    } finally {
      rejectReady?.(new Error("SSH connector closed before readiness"));
      resolveExit();
    }
  };
  socket.on("upgrade", response => {
    report(options.diagnostics, "wss", "verified", "none", { httpStatus: response.statusCode });
    if (origin.protocol === "wss:") report(options.diagnostics, "tls", "verified");
    pendingStage = "ssh-host";
  });
  socket.on("unexpected-response", (_request, response) => {
    if (!closed) report(options.diagnostics, "wss", "failed", "upgrade-denied", { httpStatus: response.statusCode });
    response.destroy(); close();
  });
  socket.on("error", error => {
    if (!closed) {
      const reason = networkReason(error);
      if (reason === "tls-certificate" || reason === "tls-handshake") report(options.diagnostics, "tls", "failed", reason);
      report(options.diagnostics, "wss", "failed", reason);
    }
    close();
  });
  socket.on("close", () => { if (!closed) report(options.diagnostics, "wss", "closed", "peer-closed"); close(); });
  stream.on("error", () => { if (!closed) report(options.diagnostics, pendingStage, "failed", "peer-closed"); close(); });
  const peerEnded = () => { if (!closed) report(options.diagnostics, pendingStage, "closed", "peer-closed"); close(); };
  stream.on("end", peerEnded); stream.on("close", peerEnded);
  ssh.on("error", error => {
    if (!closed && !hostRejected) {
      const authentication = "level" in error && error.level === "client-authentication";
      report(options.diagnostics, authentication ? "ssh-auth" : pendingStage, "failed", authentication ? "ssh-auth-rejected" : "ssh-handshake");
    }
    close();
  });
  ssh.on("end", peerEnded); ssh.on("close", peerEnded);
  ssh.on("tcp connection", (info, accept, reject) => {
    if (closed || !registered || info.destIP !== "127.0.0.1" || info.destPort !== options.reversePort || local.size >= CHANNEL_LIMIT) { reject(); return; }
    // Only local configuration crosses this boundary, never relay metadata.
    forwardFixedBridge({ bridgePort: options.bridgePort, sockets: local, current: () => !closed && registered, accept, reject });
  });
  let deadline: NodeJS.Timeout;
  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    deadline = setTimeout(() => { report(options.diagnostics, pendingStage, "failed", "timeout"); close(); reject(new Error("SSH reverse-listener deadline exceeded")); }, 5000);
    ssh.once("error", () => reject(new Error("SSH connector authentication failed")));
    ssh.once("close", () => reject(new Error("SSH connector closed before readiness")));
    ssh.once("ready", () => {
      report(options.diagnostics, "ssh-auth", "verified");
      pendingStage = "reverse";
      report(options.diagnostics, "reverse", "pending");
      ssh.forwardIn("127.0.0.1", options.reversePort, error => {
        if (error || closed) { report(options.diagnostics, "reverse", "failed", "reverse-rejected"); reject(new Error("Fixed reverse listener rejected")); }
        else { registered = true; rejectReady = undefined; report(options.diagnostics, "reverse", "verified"); resolve(); }
      });
    });
  });
  ready.catch(() => {});
  options.signal?.addEventListener("abort", close, { once: true });
  try {
    options.signal?.throwIfAborted();
    ssh.connect({
    sock: stream, username: "machine-connector", privateKey: options.privateKey,
    hostHash: "sha256", hostVerifier: (hash: string) => {
      const accepted = timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(options.hostFingerprint, "hex"));
      hostRejected = !accepted;
      report(options.diagnostics, "ssh-host", accepted ? "verified" : "failed", accepted ? "none" : "host-pin-mismatch");
      if (accepted) { pendingStage = "ssh-auth"; report(options.diagnostics, "ssh-auth", "pending"); }
      return accepted;
    },
    readyTimeout: 5000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
    });
    await ready;
  } catch { close(); throw new Error("SSH/WSS connector failed; inspect bounded diagnostics"); } finally { clearTimeout(deadline!); }
  return { exited, running: () => !closed, async close() { disposing = true; close(); await exited; } };
}

/** Relay-side SSH endpoint; only one authenticated connector and TCP reverse listener. */
export async function openTunnelRelay(options: {
  hostKey: string; authorizedKey: string; reversePort: number; port?: number;
  bind?: "127.0.0.1" | "0.0.0.0"; publicAuthority?: string; diagnostics?: AdmissionDiagnostics;
}) {
  port(options.reversePort);
  const authorized = utils.parseKey(options.authorizedKey);
  if (authorized instanceof Error || Array.isArray(authorized)) throw new Error("Invalid connector public key");
  let active: Connection | undefined;
  let reverse: ReturnType<typeof createServer> | undefined;
  let closed = false;
  const connections = new Set<Connection>();
  const dataSockets = new Set<Socket>();
  const wireSockets = new Set<Socket>();
  const acceptClient = (client: Connection, onReady: () => void, onFault: () => void) => {
    let retired = false;
    const deadline = setTimeout(() => { retire(); onFault(); }, 5000);
    const retire = () => {
      if (retired) return;
      retired = true;
      clearTimeout(deadline);
      connections.delete(client);
      if (active === client) {
        active = undefined;
        reverse?.close(); reverse = undefined;
        for (const socket of dataSockets) socket.destroy();
        dataSockets.clear();
      }
    };
    connections.add(client);
    client.once("end", retire); client.on("error", () => { retire(); onFault(); }); client.once("close", retire);
    if (closed || connections.size > 4) { retire(); onFault(); return; }
    client.on("authentication", context => {
      if (closed || retired || (active && active !== client)) { context.reject(); return; }
      if (context.username !== "machine-connector" || context.method !== "publickey" ||
          !authorized.getPublicSSH().equals(context.key.data) ||
          (context.signature && !validSignatureProof(() => authorized.verify(context.blob!, context.signature!, context.hashAlgo)))) { context.reject(); return; }
      context.accept();
    });
    client.on("ready", () => {
      if (closed || retired || (active && active !== client)) { retire(); onFault(); return; }
      clearTimeout(deadline); onReady(); active = client;
    });
    client.on("session", (_accept, reject) => reject());
    client.on("tcpip", (_accept, reject) => reject());
    client.on("request", (accept, reject, name, info) => {
      if (closed || retired || name !== "tcpip-forward" || !info || info.bindAddr !== "127.0.0.1" || info.bindPort !== options.reversePort || reverse || active !== client) { reject?.(); return; }
      const listener = createServer(socket => {
        forwardReverseSocket({
          socket, sockets: dataSockets, current: () => !closed && !retired && active === client,
          request: done => client.forwardOut("127.0.0.1", options.reversePort, "127.0.0.1", socket.remotePort ?? 0, (error, channel) => done(error, channel)),
          stalled: () => { retire(); onFault(); },
        });
      });
      reverse = listener;
      listener.once("error", () => { if (reverse === listener) reverse = undefined; reject?.(); });
      listener.listen(options.reversePort, "127.0.0.1", () => {
        if (closed || retired || active !== client || reverse !== listener) { listener.close(); return; }
        accept?.();
      });
    });
  };
  const http = createHttpServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 }, (_req, res) => { res.writeHead(403, { connection: "close", "cache-control": "no-store" }); res.end(); });
  const ws = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024, maxFragments: 64, maxBufferedChunks: 128 });
  http.maxConnections = 4;
  http.on("connection", socket => { wireSockets.add(socket); socket.on("error", () => {}); socket.once("close", () => wireSockets.delete(socket)); socket.setTimeout(5000, () => socket.destroy()); });
  http.on("clientError", (_error, socket) => socket.destroy());
  const upgrade = (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    wireSockets.add(req.socket);
    req.socket.once("close", () => wireSockets.delete(req.socket));
    if (closed || req.method !== "GET" || req.url !== CONNECTOR_PATH || (options.publicAuthority && req.headers.host !== options.publicAuthority) || req.headers.origin || req.headers.authorization || req.headers.cookie || req.headers["x-vercel-access"] || ws.clients.size >= 4) {
      options.diagnostics?.record({ reason: options.publicAuthority && req.headers.host !== options.publicAuthority ? "host-mismatch" : ws.clients.size >= 4 ? "capacity" : "upgrade", headerNames: ["origin", "authorization", "cookie", "x-vercel-access"].filter(name => req.headers[name] !== undefined), route: "connector", method: methodCategories.includes(req.method as MethodCategory) ? req.method as MethodCategory : "OTHER", status: null, hostMatches: !options.publicAuthority || req.headers.host === options.publicAuthority });
      socket.destroy(); return;
    }
    try { ws.handleUpgrade(req, socket, head, websocket => {
      req.socket.setTimeout(0);
      websocket.on("error", () => {});
      const stream = createWebSocketStream(websocket, { highWaterMark: 64 * 1024 });
      stream.on("error", () => websocket.terminate());
      const handshake = setTimeout(() => websocket.terminate(), 5000);
      websocket.once("close", () => clearTimeout(handshake));
      const session = new Server({ hostKeys: [options.hostKey] }, client => {
        acceptClient(client, () => clearTimeout(handshake), () => websocket.terminate());
        stream.once("close", () => client.end());
        client.once("close", () => websocket.terminate());
      });
      session.on("error", () => websocket.terminate());
      session.injectSocket(stream as Socket);
    }); } catch { socket.destroy(); }
  };
  http.on("upgrade", upgrade);
  http.listen(options.port ?? 0, options.bind ?? "127.0.0.1"); await once(http, "listening");
  return {
    url: `ws://127.0.0.1:${(http.address() as { port: number }).port}`,
    upgrade,
    async close() {
      if (closed) return;
      closed = true;
      for (const client of connections) client.end();
      for (const socket of dataSockets) socket.destroy();
      dataSockets.clear();
      for (const socket of wireSockets) socket.destroy();
      reverse?.close(); reverse = undefined;
      for (const socket of ws.clients) socket.terminate();
      ws.close();
      await new Promise<void>(resolve => http.close(() => resolve()));
    },
  };
}

export function hostFingerprint(privateKey: string) {
  const key = utils.parseKey(privateKey);
  if (key instanceof Error || Array.isArray(key)) throw new Error("Invalid SSH key");
  return createHash("sha256").update(key.getPublicSSH()).digest("hex");
}
