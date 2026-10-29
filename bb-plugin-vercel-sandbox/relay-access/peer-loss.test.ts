import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startConnector, hostFingerprint } from "./tunnel.ts";
import { syntheticKeys } from "./integration/keys.ts";
import { freePort } from "./integration/isolated.ts";

async function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Peer-loss cleanup deadline exceeded")), ms); })]); }
  finally { clearTimeout(timer); }
}

for (const active of [false, true]) test(`standalone relay SIGTERM settles connector exit without caller close (${active ? "active" : "idle"})`, { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "vercel-access-peer-loss-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const host = syntheticKeys(); const client = syntheticKeys();
  const reversePort = await freePort(); const publicPort = await freePort();
  const held = new Set<Socket>();
  let admitted!: () => void;
  const admittedSocket = new Promise<void>(resolve => { admitted = resolve; });
  const bridge = createServer(socket => { held.add(socket); socket.on("error", () => {}); socket.resume(); socket.once("close", () => held.delete(socket)); admitted(); });
  bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
  t.after(async () => { for (const socket of held) socket.destroy(); await new Promise<void>(resolve => bridge.close(() => resolve())); });
  const config = {
    publicAuthority: `127.0.0.1:${publicPort}`, port: publicPort, reversePort,
    bridgePort: (bridge.address() as { port: number }).port,
    hostKeyFile: join(directory, "relay-key"), authorizedKeyFile: join(directory, "connector.pub"),
  };
  await writeFile(config.hostKeyFile, host.privateKey, { mode: 0o600 });
  await writeFile(config.authorizedKeyFile, client.publicKey, { mode: 0o600 });
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: join(directory, ".config"), XDG_CACHE_HOME: join(directory, ".cache"), XDG_DATA_HOME: join(directory, ".local/share") };
  const relay = spawn(process.execPath, [fileURLToPath(new URL("./relay-main.ts", import.meta.url)), configPath], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  relay.on("error", () => {});
  let output = "";
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => relay.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (relay.exitCode === null && relay.signalCode === null) { relay.kill("SIGKILL"); await exited; } });
  await within(new Promise<void>((resolve, reject) => {
    relay.stdout.on("data", chunk => { output = (output + chunk).slice(-65536); if (output.includes("Machine relay ready")) resolve(); });
    relay.stderr.on("data", () => {});
    exited.then(() => reject(new Error("Standalone relay exited before readiness")));
  }));
  const connector = await startConnector({ relayUrl: `ws://127.0.0.1:${publicPort}`, privateKey: client.privateKey, hostFingerprint: hostFingerprint(host.privateKey), bridgePort: config.bridgePort, reversePort });
  t.after(() => connector.close());
  let localClosed = Promise.resolve();
  if (active) {
    const consumer = connect({ host: "127.0.0.1", port: reversePort }); consumer.on("error", () => {}); t.after(() => consumer.destroy());
    await within(admittedSocket);
    localClosed = Promise.all([...held].map(socket => new Promise<void>(resolve => socket.once("close", () => resolve())))).then(() => {});
  }
  relay.kill("SIGTERM");
  const [result] = await within(Promise.all([exited, connector.exited, localClosed]));
  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(connector.running(), false);
  assert.equal(held.size, 0);
  assert.ok(!output.includes(host.privateKey) && !output.includes(client.privateKey));
});
