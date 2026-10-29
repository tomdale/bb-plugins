import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer, request } from "node:http";
import { once } from "node:events";

export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

export function http(base: string, target: string, options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<{ status: number; body: Buffer; headers: import("node:http").IncomingHttpHeaders }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, method: options.method ?? "GET", path: target, headers: options.headers, agent: false, timeout: 10_000 }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on("timeout", () => req.destroy(new Error("HTTP timeout")));
    req.on("error", reject);
    req.end(options.body);
  });
}

export async function isolatedCore() {
  const directory = await mkdtemp(join(tmpdir(), "bb-vercel-access-core-"));
  const port = await freePort();
  const daemonPort = await freePort();
  const home = join(directory, "isolated-home");
  await mkdir(home, { mode: 0o700 });
  // Child processes receive tool locations and locale, not the caller's
  // account credentials, agent configuration, HOME, XDG state or BB identity.
  const inherited = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "PROTO_HOME", "PROTO_ROOT"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited.has(key)));
  Object.assign(env, {
    PATH: `${dirname(process.execPath)}:${env.PATH ?? ""}`,
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
    NPM_CONFIG_CACHE: join(home, ".npm"), NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
    BB_DATA_DIR: directory, BB_SERVER_BIND_HOST: "127.0.0.1", BB_SERVER_PORT: String(port),
    BB_HOST_DAEMON_PORT: String(daemonPort), BB_SERVER_URL: `http://127.0.0.1:${port}`,
  });
  const entry = process.env.BB_TEST_SERVER_JS ?? "/Applications/bb Personal.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist/index.js";
  let child: ChildProcess;
  let logs = "";
  const baseUrl = env.BB_SERVER_URL!;
  const start = async () => {
    child = spawn(process.execPath, [entry], { env, cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => {});
    const capture = (data: Buffer) => { logs = (logs + data.toString()).slice(-1024 * 1024); };
    child.stdout!.on("data", capture); child.stderr!.on("data", capture);
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`Isolated BB exited (${child.exitCode}); no live server used`);
      try { if ((await http(baseUrl, "/health")).status === 200) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("Isolated BB did not start");
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timer);
  };
  try { await start(); } catch (error) { await stop(); await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    baseUrl, directory, env, serverEntry: entry, logs: () => logs,
    async restart() { await stop(); await start(); },
    async close() { await stop(); await rm(directory, { recursive: true, force: true }); },
  };
}
