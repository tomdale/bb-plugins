import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { enableErrors, safeAccessError } from "../../access-errors.ts";
import { http, isolatedCore } from "./isolated.ts";

const exec = promisify(execFile);
test("native RPC delivers a safe, specific enable failure and exposes no internal identity setting", { timeout: 90_000 }, async t => {
  const core = await isolatedCore();
  t.after(() => core.close());
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const secrets = join(core.directory, "plugins/environment-vercel-sandbox/secrets");
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  await writeFile(join(secrets, "relayIdentity"), "invalid-synthetic-private-material", { mode: 0o600 });
  await exec("bb", ["plugin", "install", root, "--yes"], { env: core.env, cwd: core.directory, timeout: 60_000 });
  const response = await http(core.baseUrl, "/api/v1/plugins/environment-vercel-sandbox/rpc/access.enable", {
    method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": "2" },
  });
  assert.equal(response.status, 500);
  const body = JSON.parse(response.body.toString());
  assert.equal(body.error.code, "handler_error");
  assert.equal(safeAccessError(new Error(body.error.message)), enableErrors.prepare);
  assert.ok(!response.body.includes("invalid-synthetic-private-material"));
  const settings = await http(core.baseUrl, "/api/v1/plugins/environment-vercel-sandbox/settings");
  assert.ok(!settings.body.includes("relayIdentity"));
});
