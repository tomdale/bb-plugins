import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("declared build succeeds from cold isolated HOME/data despite package npm flags", { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "vercel-access-cold-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const userConfig = join(directory, "user.npmrc"); const globalConfig = join(directory, "global.npmrc");
  await writeFile(userConfig, "", { mode: 0o600 }); await writeFile(globalConfig, "", { mode: 0o600 });
  const permitted = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "PROTO_HOME", "PROTO_ROOT"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => permitted.has(key)));
  Object.assign(env, {
    PATH: `${dirname(process.execPath)}:${env.PATH ?? ""}`,
    HOME: directory, XDG_CONFIG_HOME: join(directory, ".config"), XDG_CACHE_HOME: join(directory, ".cache"), XDG_DATA_HOME: join(directory, ".local/share"),
    BB_DATA_DIR: join(directory, "cold-bb-data"), NPM_CONFIG_CACHE: join(directory, "cold-npm-cache"),
    NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_OMIT: "optional", NPM_CONFIG_IGNORE_SCRIPTS: "true",
  });
  const npmPolicy = await readFile(join(root, ".npmrc"), "utf8");
  assert.match(npmPolicy, /omit=optional/); assert.match(npmPolicy, /ignore-scripts=true/);
  const result = await exec("npm", ["run", "build"], { cwd: root, env, timeout: 110_000, maxBuffer: 1024 * 1024 });
  assert.match(result.stdout, /dist\/server\.js/);
  const metadata = JSON.parse(await readFile(join(root, "dist/server.meta.json"), "utf8"));
  assert.equal(metadata.pluginId, "vercel-access");
  assert.equal(metadata.sdkVersion, "0.6.100");
  assert.equal(metadata.builtWith.bbVersion, "0.48.0");
});
