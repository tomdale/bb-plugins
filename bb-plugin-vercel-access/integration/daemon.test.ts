import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AdmissionLeases } from "../grants.ts";
import { openBridge, openRelayAdapter } from "../bridge.ts";
import { openTunnelRelay, startConnector, hostFingerprint } from "../tunnel.ts";
import { syntheticKeys } from "./keys.ts";
import { http, isolatedCore, freePort } from "./isolated.ts";
import { ACCESS_HEADER } from "../policy.ts";

test("released native daemon foreground session over SSH/WS with entirely temporary HOME and data", { timeout: 90_000 }, async t => {
  const core = await isolatedCore(); t.after(() => core.close());
  const leases = new AdmissionLeases();
  const bridge = await openBridge({ baseUrl: core.baseUrl, leases }); t.after(() => bridge.close());
  const host = syntheticKeys(); const client = syntheticKeys();
  const reversePort = await freePort(); const publicPort = await freePort();
  const bridgePort = Number(new URL(bridge.url).port);
  const relay = await openTunnelRelay({ hostKey: host.privateKey, authorizedKey: client.publicKey, reversePort }); t.after(() => relay.close());
  const adapter = await openRelayAdapter({ reversePort, bridgePort, publicAuthority: `127.0.0.1:${publicPort}`, port: publicPort, connector: relay }); t.after(() => adapter.close());
  const connector = await startConnector({ relayUrl: adapter.url.replace("http:", "ws:"), privateKey: client.privateKey, hostFingerprint: hostFingerprint(host.privateKey), reversePort, bridgePort }); t.after(() => connector.close());
  const enrollmentReply = await http(core.baseUrl, "/internal/hosts/enroll-key", { method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": "2" } });
  assert.equal(enrollmentReply.status, 201);
  const enrollment = JSON.parse(enrollmentReply.body.toString());
  const grant = leases.acquire("synthetic-released-daemon", enrollment.hostId, new AbortController().signal);
  const home = join(core.directory, "worker-home"); const data = join(home, "data");
  await mkdir(data, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(Object.entries(core.env).filter(([key]) => !key.startsWith("BB_") && !key.startsWith("XDG_")));
  Object.assign(env, {
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
    BB_DATA_DIR: data, BB_SERVER_URL: adapter.url, BB_HOST_DAEMON_PORT: String(await freePort()),
    BB_HOST_ID: enrollment.hostId, BB_HOST_ENROLL_KEY: enrollment.enrollKey,
    BB_SERVER_HEADERS: JSON.stringify({ [ACCESS_HEADER]: grant.token }), BB_HOST_DAEMON_AUTO_UPDATE: "false", BB_HOST_DAEMON_SUPERVISED: "false",
  });
  const entry = process.env.BB_TEST_DAEMON_JS ?? "/Applications/bb Personal.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/dist/bb-app.js";
  const daemon = spawn(process.execPath, [entry, "host-daemon"], { cwd: home, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  daemon.stdout.on("data", data => { logs = (logs + data).slice(-1024 * 1024); });
  daemon.stderr.on("data", data => { logs = (logs + data).slice(-1024 * 1024); });
  daemon.on("error", () => {});
  t.after(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exit = once(daemon, "exit");
      const killGroup = (signal: NodeJS.Signals) => { try { process.kill(-daemon.pid!, signal); } catch {} };
      killGroup("SIGTERM");
      const timer = setTimeout(() => killGroup("SIGKILL"), 5000);
      await exit; clearTimeout(timer);
      killGroup("SIGKILL");
    }
  });
  let connected = false;
  for (let attempt = 0; attempt < 160; attempt++) {
    assert.equal(daemon.exitCode, null, "Isolated released daemon must stay running");
    const response = await http(core.baseUrl, `/api/v1/hosts/${enrollment.hostId}`);
    if (response.status === 200 && JSON.parse(response.body.toString()).status === "connected") { connected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(connected, true, "Released native daemon enrolled and connected its actual session/WS protocol");
  for (const secret of [enrollment.enrollKey, grant.token, client.privateKey]) {
    assert.ok(!logs.includes(secret)); assert.ok(!core.logs().includes(secret));
  }
  leases.release(grant.key, grant.hostId, grant.id);
  let disconnected = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await http(core.baseUrl, `/api/v1/hosts/${enrollment.hostId}`);
    if (JSON.parse(response.body.toString()).status === "disconnected") { disconnected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(disconnected, true, "Transport revoke closes the actual native daemon stream");
});
