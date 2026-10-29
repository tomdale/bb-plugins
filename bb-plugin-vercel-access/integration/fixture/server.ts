import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { WebSocket } from "ws";
import { once } from "node:events";
import { request } from "node:http";

const DAEMON_PROTOCOL = "bb-host-daemon.v1";
const TESTED_CORE = { protocolVersion: 244 };
async function http(base: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string }) {
  const url = new URL(base);
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path, method: options.method ?? "GET", headers: options.headers, agent: false, timeout: 10_000 }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Native fixture timeout")));
    req.end(options.body);
  });
}

/* Synthetic executor: consumes core's private bootstrap stdin without logging
 * it, then speaks the native enrollment/session protocol instead of installing
 * a daemon or starting agent processes. This fixture is never a shipped plugin.
 */
export default function fixture(bb: BbPluginApi) {
  const sockets = new Map<string, WebSocket>();
  bb.onDispose(() => { for (const socket of sockets.values()) socket.terminate(); });
  bb.experimental_machines.register({
    id: "native-fixture", displayName: "Native protocol fixture", description: "Synthetic isolated machine only", icon: "Server",
    async create({ key, report, signal }) {
      const { hostId } = await bb.experimental_machines.bootstrap({
        key, report, signal,
        executor: {
          async exec({ command, stdin, signal }) {
            signal.throwIfAborted();
            if (!command.includes("bb-machine-install") || !stdin) throw new Error("Expected initial bootstrap");
            const boot = JSON.parse(stdin) as { hostId: string; serverUrl: string; credential: string; headers: Record<string, string> };
            const installer = await http(boot.serverUrl, "/install.sh", { headers: boot.headers });
            if (installer.status !== 200 || !installer.body.includes("bootstrap")) throw new Error("Generic installer failed");
            const post = async (path: string, value: unknown, token: string) => {
              const body = JSON.stringify(value);
              const reply = await http(boot.serverUrl, path, {
                method: "POST", body,
                headers: { ...boot.headers, authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
              });
              if (reply.status !== 201) throw new Error("Native fixture operation failed");
              return JSON.parse(reply.body.toString());
            };
            const enrolled = await post("/internal/hosts/enroll", { hostId: boot.hostId, hostName: "Synthetic bootstrap worker" }, boot.credential);
            const session = await post("/internal/session/open", {
              hostId: boot.hostId, instanceId: "fixture-instance", hostName: "Synthetic bootstrap worker", hasMachineCredential: false,
              platform: "linux", dataDir: "/tmp/synthetic-workspace", localApiPort: null, protocolVersion: TESTED_CORE.protocolVersion, activeThreads: [],
            }, enrolled.hostKey);
            const socket = new WebSocket(`${boot.serverUrl.replace("http:", "ws:")}/internal/ws?sessionId=${session.sessionId}`, [DAEMON_PROTOCOL], {
              headers: { ...boot.headers, authorization: `Bearer ${enrolled.hostKey}` }, perMessageDeflate: false,
            });
            socket.on("error", () => {});
            sockets.set(boot.hostId, socket);
            await once(socket, "open");
            socket.send(JSON.stringify({ type: "heartbeat" }));
            return { exitCode: 0 };
          },
        },
      });
      return { status: "created", name: "Synthetic bootstrap worker", resource: { fixtureHostId: hostId } };
    },
    async remove({ resource }) {
      if (resource && typeof resource === "object" && "fixtureHostId" in resource) sockets.get(String(resource.fixtureHostId))?.terminate();
      return { status: "removed" };
    },
    async reconcileCleanup() { return { status: "removed" }; },
  });
}
