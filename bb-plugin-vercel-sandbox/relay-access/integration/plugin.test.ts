import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { http, freePort, isolatedCore } from "./isolated.ts";
import { syntheticKeys } from "./keys.ts";
import { openRelayAdapter } from "../bridge.ts";
import { openTunnelRelay, hostFingerprint } from "../tunnel.ts";

const exec = promisify(execFile);

for (const transport of ["loopback-test", "ssh-ws"]) test(`throwaway plugin activation and public machine bootstrap helper (${transport})`, { timeout: 180_000 }, async t => {
  const core = await isolatedCore();
  t.after(() => core.close());
  const pluginRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  const cli = async (args: string[]) => {
    try { return await exec("bb", args, { env: core.env, cwd: core.directory, timeout: 60_000, maxBuffer: 1024 * 1024 }); }
    catch { throw new Error(`Isolated CLI failed: ${args.slice(0, 2).join(" ")}`); }
  };
  const status = await cli(["status"]);
  assert.ok(status.stdout.includes(core.directory), "CLI confirmed isolated data directory");
  const port = await freePort();
  let serverUrl = `http://127.0.0.1:${port}`;
  const extra: string[][] = [];
  if (transport === "ssh-ws") {
    const host = syntheticKeys(); const client = syntheticKeys();
    const reversePort = await freePort(); const publicPort = await freePort();
    const relay = await openTunnelRelay({ hostKey: host.privateKey, authorizedKey: client.publicKey, reversePort });
    t.after(() => relay.close());
    const adapter = await openRelayAdapter({ reversePort, bridgePort: port, publicAuthority: `127.0.0.1:${publicPort}`, port: publicPort, connector: relay });
    t.after(() => adapter.close());
    serverUrl = adapter.url;
    extra.push(["transport", "ssh-ws"], ["relayUrl", serverUrl.replace("http:", "ws:")], ["relayFingerprint", hostFingerprint(host.privateKey)], ["connectorPrivateKey", client.privateKey], ["reversePort", String(reversePort)]);
  }
  const values = { ...Object.fromEntries(extra.map(([key, value]) => [key, key === "reversePort" ? Number(value) : value])), port, serverUrl, enabled: true };
  const secrets = join(core.directory, "plugins/environment-vercel-sandbox/secrets");
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  await writeFile(join(secrets, "relayIdentity"), JSON.stringify(values), { mode: 0o600 });
  await cli(["plugin", "install", pluginRoot, "--yes"]);
  const listing = await cli(["plugin", "list"]);
  assert.match(listing.stdout, /environment-vercel-sandbox.*running/);
  const settingsReply = await http(core.baseUrl, "/api/v1/plugins/environment-vercel-sandbox/settings");
  assert.equal(settingsReply.status, 200);
  assert.ok(!settingsReply.body.includes("relayIdentity"), "No internal identity field is declared to the frontend");
  const privateDb = join(core.directory, "plugins/environment-vercel-sandbox/data.db");
  assert.equal((await stat(privateDb)).mode & 0o777, 0o600);
  const configuration = JSON.parse((await http(core.baseUrl, "/api/v1/system/config")).body.toString());
  const accessSettings = JSON.stringify({ ...configuration.generalSettings, defaultMachineAccess: "vercel-sandbox-relay" });
  assert.equal((await http(core.baseUrl, "/api/v1/settings/general", {
    method: "PUT", body: accessSettings, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(accessSettings)) },
  })).status, 200);
  await cli(["plugin", "install", `${pluginRoot}/relay-access/integration/fixture`, "--yes"]);
  let providers: { id: string; pluginId?: string }[] = [];
  for (let i = 0; i < 40; i++) {
    const response = await http(core.baseUrl, "/api/v1/system/machine-providers");
    assert.equal(response.status, 200);
    providers = JSON.parse(response.body.toString()).providers;
    if (providers.some(provider => provider.id.includes("native-fixture"))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const provider = providers.find(provider => provider.id.includes("native-fixture"));
  assert.ok(provider, `Providers: ${JSON.stringify(providers)}; plugins: ${(await cli(["plugin", "list"])).stdout}`);
  const createdBody = JSON.stringify({ machineProviderId: provider.id, inputs: null, key: "synthetic-bootstrap-launch" });
  const created = await http(core.baseUrl, "/api/v1/hosts", {
    method: "POST", body: createdBody, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(createdBody)) },
  });
  assert.equal(created.status, 201, created.body.toString());
  const hostId = JSON.parse(created.body.toString()).id as string;
  let host: { lifecycle: { phase: string }; connected?: boolean } | undefined;
  for (let i = 0; i < 100; i++) {
    const response = await http(core.baseUrl, `/api/v1/hosts/${hostId}`);
    assert.equal(response.status, 200);
    host = JSON.parse(response.body.toString());
    if (host?.lifecycle.phase === "active") break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(host?.lifecycle.phase, "active", `Public bootstrap result: ${JSON.stringify(host)}`);
  const enabled = await cli(["plugin", "list"]);
  assert.match(enabled.stdout, /environment-vercel-sandbox.*running/);
  // Disabling does not wait for a reload to close admitted streams/listener.
  const stopped = await http(core.baseUrl, "/api/v1/plugins/environment-vercel-sandbox/rpc/access.disable", {
    method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": "2" },
  });
  assert.equal(stopped.status, 200);
  await assert.rejects(http(`http://127.0.0.1:${port}`, "/install/version"));
});
