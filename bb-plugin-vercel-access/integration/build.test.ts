import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, access, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { syntheticKeys } from "./keys.ts";
import { freePort } from "./isolated.ts";
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
  assert.equal(metadata.sdkVersion, "0.6.59");
  assert.equal(metadata.builtWith.bbVersion, "0.46.1");
});

test("minimal production-source relay starts without BB SDK or plugin server entry", { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "vercel-access-sdk-free-relay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../", import.meta.url));
  const staged = join(directory, "relay"); await mkdir(staged, { mode: 0o700 });
  for (const file of ["relay-main.ts", "bridge.ts", "tunnel.ts", "channels.ts", "policy.ts", "grants.ts", "package.json", "package-lock.json", ".npmrc"]) await copyFile(join(source, file), join(staged, file));
  const userConfig = join(directory, "user.npmrc"); const globalConfig = join(directory, "global.npmrc");
  await writeFile(userConfig, "", { mode: 0o600 }); await writeFile(globalConfig, "", { mode: 0o600 });
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: directory,
    XDG_CONFIG_HOME: join(directory, ".config"), XDG_CACHE_HOME: join(directory, ".cache"), XDG_DATA_HOME: join(directory, ".local/share"),
    NPM_CONFIG_CACHE: join(directory, "npm-cache"), NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
  };
  await exec("npm", ["ci", "--omit=dev"], { cwd: staged, env, timeout: 60_000, maxBuffer: 1024 * 1024 });
  await assert.rejects(access(join(staged, "node_modules/@get-bb/plugin-sdk")));
  await assert.rejects(access(join(staged, "server.ts")));
  const host = syntheticKeys(); const client = syntheticKeys();
  const publicPort = await freePort();
  const config = {
    publicAuthority: `127.0.0.1:${publicPort}`, port: publicPort, reversePort: await freePort(), bridgePort: await freePort(),
    hostKeyFile: join(directory, "relay.key"), authorizedKeyFile: join(directory, "connector.pub"),
  };
  await writeFile(config.hostKeyFile, host.privateKey, { mode: 0o600 });
  await writeFile(config.authorizedKeyFile, client.publicKey, { mode: 0o600 });
  const configPath = join(directory, "relay.json"); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  // This is the pinned standalone launch, not the BB plugin-server bundle.
  const child = spawn(process.execPath, ["relay-main.ts", configPath], { cwd: staged, env, stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", () => {});
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } });
  let output = "";
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.stdout.on("data", chunk => { output = (output + chunk).slice(-65536); if (output.includes("Machine relay ready")) resolve(); });
        child.stderr.on("data", chunk => { output = (output + chunk).slice(-65536); });
        exited.then(() => reject(new Error("Standalone relay exited before readiness")));
      }),
      new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("Standalone relay readiness deadline")), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.ok(!output.includes(host.privateKey) && !output.includes(client.privateKey));
});
