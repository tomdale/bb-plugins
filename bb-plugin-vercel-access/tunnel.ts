import { createServer, connect, type Socket } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import ssh2, { type Connection } from "ssh2";
const { Client, Server, utils } = ssh2;
import { WebSocket, WebSocketServer, createWebSocketStream } from "ws";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";

export const CONNECTOR_PATH = "/machine-connector";
const channelLimit = 16;

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
  relayUrl: string; privateKey: string; hostFingerprint: string; bridgePort: number; reversePort: number; signal?: AbortSignal;
}) {
  options.signal?.throwIfAborted();
  port(options.bridgePort); port(options.reversePort);
  const origin = new URL(options.relayUrl);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      (origin.protocol !== "wss:" && !(origin.protocol === "ws:" && origin.hostname === "127.0.0.1"))) throw new Error("Expected WSS control origin or isolated WS loopback origin");
  if (!/^[a-f0-9]{64}$/.test(options.hostFingerprint)) throw new Error("Expected SHA-256 SSH host key fingerprint in hex");
  const privateKey = utils.parseKey(options.privateKey);
  if (privateKey instanceof Error) throw new Error("Invalid dedicated connector private key");
  const socket = new WebSocket(new URL(CONNECTOR_PATH, origin), {
    perMessageDeflate: false, maxPayload: 64 * 1024, maxFragments: 64, maxBufferedChunks: 128,
    handshakeTimeout: 5000, followRedirects: false, rejectUnauthorized: true,
  });
  const stream = createWebSocketStream(socket, { highWaterMark: 64 * 1024 });
  const ssh = new Client();
  const local = new Set<Socket>();
  let closed = false;
  let registered = false;
  const close = () => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", close);
    registered = false;
    for (const connection of local) connection.destroy();
    ssh.destroy(); stream.destroy(); socket.terminate();
  };
  const exited = new Promise<void>(resolve => ssh.once("close", () => { close(); resolve(); }));
  socket.on("error", close); stream.on("error", close); ssh.on("error", close);
  ssh.on("tcp connection", (info, accept, reject) => {
    if (closed || !registered || info.destIP !== "127.0.0.1" || info.destPort !== options.reversePort || local.size >= channelLimit) { reject(); return; }
    // Source address and every other relay-supplied field are deliberately
    // ignored. This literal destination is the compromised-relay boundary.
    const destination = connect({ host: "127.0.0.1", port: options.bridgePort });
    local.add(destination);
    let channel: ReturnType<typeof accept> | undefined;
    destination.on("error", () => { channel?.destroy(); if (!channel) reject(); });
    destination.on("connect", () => { if (closed || !registered) { destination.destroy(); reject(); return; } channel = accept(); channel.on("error", () => destination.destroy()); channel.on("close", () => destination.destroy()); destination.pipe(channel).pipe(destination); });
    destination.on("close", () => { local.delete(destination); channel?.destroy(); });
  });
  let deadline: NodeJS.Timeout;
  const ready = new Promise<void>((resolve, reject) => {
    deadline = setTimeout(() => { close(); reject(new Error("SSH reverse-listener deadline exceeded")); }, 5000);
    ssh.once("error", () => reject(new Error("SSH connector authentication failed")));
    ssh.once("close", () => reject(new Error("SSH connector closed before readiness")));
    ssh.once("ready", () => {
      ssh.forwardIn("127.0.0.1", options.reversePort, error => {
        if (error || closed) reject(new Error("Fixed reverse listener rejected"));
        else { registered = true; resolve(); }
      });
    });
  });
  ready.catch(() => {});
  options.signal?.addEventListener("abort", close, { once: true });
  try {
    options.signal?.throwIfAborted();
    ssh.connect({
    sock: stream, username: "machine-connector", privateKey: options.privateKey,
    hostHash: "sha256", hostVerifier: (hash: string) => timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(options.hostFingerprint, "hex")),
    readyTimeout: 5000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
    });
    await ready;
  } catch (error) { close(); throw error; } finally { clearTimeout(deadline!); }
  return { exited, running: () => !closed, async close() { close(); await exited; } };
}

/** Relay-side SSH endpoint; only one authenticated connector and TCP reverse listener. */
export async function openTunnelRelay(options: {
  hostKey: string; authorizedKey: string; reversePort: number; port?: number;
  bind?: "127.0.0.1" | "0.0.0.0"; publicAuthority?: string;
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
  const acceptClient = (client: Connection, onReady: () => void) => {
    const deadline = setTimeout(() => client.end(), 5000);
    connections.add(client);
    if (closed || connections.size > 4) { client.end(); return; }
    client.on("error", () => {});
    client.on("authentication", context => {
      if (active && active !== client) { context.reject(); return; }
      if (context.username !== "machine-connector" || context.method !== "publickey" ||
          !authorized.getPublicSSH().equals(context.key.data) ||
          (context.signature && !validSignatureProof(() => authorized.verify(context.blob!, context.signature!, context.hashAlgo)))) { context.reject(); return; }
      context.accept();
    });
    client.on("ready", () => { clearTimeout(deadline); onReady(); if (active && active !== client) { client.end(); return; } active = client; });
    client.on("session", (_accept, reject) => reject());
    client.on("tcpip", (_accept, reject) => reject());
    client.on("request", (accept, reject, name, info) => {
      if (name !== "tcpip-forward" || !info || info.bindAddr !== "127.0.0.1" || info.bindPort !== options.reversePort || reverse || active !== client) { reject?.(); return; }
      const listener = createServer(socket => {
        if (closed || dataSockets.size >= channelLimit || active !== client) { socket.destroy(); return; }
        dataSockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => dataSockets.delete(socket));
        client.forwardOut("127.0.0.1", options.reversePort, "127.0.0.1", socket.remotePort ?? 0, (error, channel) => {
          if (error || socket.destroyed) { socket.destroy(); channel?.destroy(); return; }
          channel.on("error", () => socket.destroy()); channel.on("close", () => socket.destroy());
          socket.on("close", () => channel.destroy());
          socket.pipe(channel).pipe(socket);
        });
      });
      reverse = listener;
      listener.once("error", () => { if (reverse === listener) reverse = undefined; reject?.(); });
      listener.listen(options.reversePort, "127.0.0.1", () => accept?.());
    });
    const retire = () => {
      clearTimeout(deadline);
      connections.delete(client);
      if (active === client) {
        active = undefined;
        reverse?.close(); reverse = undefined;
        for (const socket of dataSockets) socket.destroy();
      }
    };
    client.once("end", retire);
    client.once("error", retire);
    client.once("close", retire);
  };
  const http = createHttpServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 }, (_req, res) => { res.writeHead(403, { connection: "close", "cache-control": "no-store" }); res.end(); });
  const ws = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024, maxFragments: 64, maxBufferedChunks: 128 });
  http.maxConnections = 4;
  http.on("connection", socket => { wireSockets.add(socket); socket.on("error", () => {}); socket.once("close", () => wireSockets.delete(socket)); socket.setTimeout(5000, () => socket.destroy()); });
  http.on("clientError", (_error, socket) => socket.destroy());
  const upgrade = (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    wireSockets.add(req.socket);
    req.socket.once("close", () => wireSockets.delete(req.socket));
    if (closed || req.method !== "GET" || req.url !== CONNECTOR_PATH || (options.publicAuthority && req.headers.host !== options.publicAuthority) || req.headers.origin || req.headers.authorization || req.headers.cookie || req.headers["x-vercel-access"] || ws.clients.size >= 4) { socket.destroy(); return; }
    try { ws.handleUpgrade(req, socket, head, websocket => {
      req.socket.setTimeout(0);
      websocket.on("error", () => {});
      const stream = createWebSocketStream(websocket, { highWaterMark: 64 * 1024 });
      stream.on("error", () => websocket.terminate());
      const handshake = setTimeout(() => websocket.terminate(), 5000);
      websocket.once("close", () => clearTimeout(handshake));
      const session = new Server({ hostKeys: [options.hostKey] }, client => {
        acceptClient(client, () => clearTimeout(handshake));
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
