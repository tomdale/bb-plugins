import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Install BB's build toolchain outside the package's script-disabled npm
// context and the caller's daily BB data.
const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "bb-vercel-sandbox-build-"));
try {
  const home = join(directory, "home");
  const data = join(directory, "bb-data");
  await mkdir(home, { mode: 0o700 }); await mkdir(data, { mode: 0o700 });
  const userConfig = join(directory, "user.npmrc"); const globalConfig = join(directory, "global.npmrc");
  await writeFile(userConfig, "", { mode: 0o600 }); await writeFile(globalConfig, "", { mode: 0o600 });
  const permitted = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "PROTO_HOME", "PROTO_ROOT"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => permitted.has(key)));
  Object.assign(env, {
    PATH: `${dirname(process.execPath)}:${env.PATH ?? ""}`,
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
    BB_DATA_DIR: data, NPM_CONFIG_CACHE: join(directory, "npm-cache"),
    NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
  });
  const child = spawn("bb", ["plugin", "build", pluginRoot], { cwd: directory, env, stdio: "inherit" });
  const interrupt = () => child.kill("SIGINT"); const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); });
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
} finally { await rm(directory, { recursive: true, force: true }); }
