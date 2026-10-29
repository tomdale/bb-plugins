import { afterEach, expect, it } from "vitest";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { relayArtifact } from "./relay-artifact.js";
import { verifyRelayArtifact } from "./relay-host.js";
import { relayLaunchArgs } from "./relay-launch.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function freePort() {
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve())); return port;
}
it("pinned standalone artifact starts without npm packages or BB, reads private files and denies owner traffic — local subprocess only", async () => {
  verifyRelayArtifact();
  const root = await mkdtemp(join(tmpdir(), "relay-artifact-local-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const port = await freePort(); const reversePort = await freePort(); const bridgePort = await freePort();
  const host = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const connector = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  const authorized = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.from(connector.x!, "base64url")]);
  await Promise.all([
    writeFile(join(root, "relay.mjs"), relayArtifact.source, { mode: 0o600 }),
    writeFile(join(root, "host.pem"), host.privateKey.export({ format: "pem", type: "pkcs1" }), { mode: 0o600 }),
    writeFile(join(root, "authorized.pub"), `ssh-ed25519 ${authorized.toString("base64")}`, { mode: 0o600 }),
    writeFile(join(root, "config.json"), JSON.stringify({ publicAuthority: `127.0.0.1:${port}`, port, reversePort, bridgePort, hostKeyFile: join(root, "host.pem"), authorizedKeyFile: join(root, "authorized.pub") }), { mode: 0o600 }),
  ]);
  const process = spawn(globalThis.process.execPath, relayLaunchArgs(root), { cwd: root, env: { HOME: root, PATH: globalThis.process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  process.stdout.on("data", chunk => { output += chunk.toString(); });
  process.stderr.on("data", chunk => { output += chunk.toString(); });
  const exited = once(process, "exit");
  cleanups.push(async () => { process.kill("SIGTERM"); await Promise.race([exited, new Promise<void>(resolve => setTimeout(() => { process.kill("SIGKILL"); resolve(); }, 2000).unref())]); });
  let response: Response | undefined;
  for (let i = 0; i < 100 && process.exitCode === null; i++) {
    try { response = await fetch(`http://127.0.0.1:${port}/api/v1/threads`, { signal: AbortSignal.timeout(500) }); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  expect(output.slice(-2000)).toBe("");
  expect(response?.status).toBe(403);
  expect(output).not.toMatch(/PRIVATE KEY|authorizedKey|hostKey/);
});
