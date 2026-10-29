import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { http, isolatedCore } from "./isolated.ts";

const exec = promisify(execFile);
test("native owner migration keeps secrets server-side and Sandbox runs after the retired plugin is removed", { timeout: 120_000 }, async t => {
  const core = await isolatedCore();
  t.after(() => core.close());
  const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  const legacy = fileURLToPath(new URL("../../../bb-plugin-vercel-access", import.meta.url));
  const cli = (args: string[]) => exec("bb", args, { env: core.env, cwd: core.directory, timeout: 60_000, maxBuffer: 1024 * 1024 });
  await cli(["plugin", "install", root, "--yes"]);
  await cli(["plugin", "install", legacy, "--yes"]);
  const body = JSON.stringify({ values: { preparedConnectorPrivateKey: "synthetic-private-migration-value" } });
  const saved = await http(core.baseUrl, "/api/v1/plugins/vercel-access/settings", { method: "PUT", body,
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } });
  assert.equal(saved.status, 200);
  assert.ok(!saved.body.includes("synthetic-private-migration-value"));
  assert.deepEqual(JSON.parse((await cli(["vercel-access", "migrate"])).stdout), { migrated: true });
  assert.deepEqual(JSON.parse((await cli(["vercel-access", "migrate"])).stdout), { migrated: true });
  const settings = await http(core.baseUrl, "/api/v1/plugins/environment-vercel-sandbox/settings");
  assert.equal(settings.status, 200);
  assert.ok(!settings.body.includes("synthetic-private-migration-value"));
  await cli(["plugin", "remove", "vercel-access", "--yes"]);
  const listing = (await cli(["plugin", "list"])).stdout;
  assert.match(listing, /environment-vercel-sandbox.*running/);
  assert.doesNotMatch(listing, /^vercel-access@/m);
  const status = await http(core.baseUrl, "/api/v1/plugins/environment-vercel-sandbox/rpc/access.status", {
    method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": "2" } });
  assert.equal(status.status, 200);
  const result = JSON.parse(status.body.toString()).result;
  assert.equal(result.available, true);
  assert.equal(result.ready, false);
  assert.equal(result.key, null);
});
