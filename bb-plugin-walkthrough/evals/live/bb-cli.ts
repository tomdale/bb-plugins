// The bb CLI, as the live layer needs it: spawn and archive threads, read a
// thread's event log, list the provider catalog and find the installed plugin.
// A live run therefore needs exactly what a person has on the machine that
// serves BB: a bb CLI and provider credentials.
import { execFileSync } from "node:child_process";
import type { CatalogModel } from "../../src/service.ts";

export interface ThreadEvent {
  seq: number;
  type: string;
  createdAt: number;
  data?: {
    source?: string;
    input?: unknown[];
    execution?: { model?: string };
    item?: { type?: string; tool?: string; text?: string };
  } & Record<string, unknown>;
}

export interface InstalledPlugin {
  id: string;
  rootDir: string;
  source: string;
  status: string;
}

function run(args: readonly string[]): string {
  return execFileSync("bb", args, { encoding: "utf8", maxBuffer: 1 << 28, timeout: 300_000 });
}

function asJson<T>(raw: string): T {
  const start = raw.search(/[[{]/u);
  if (start < 0) throw new Error(`bb printed no JSON: ${raw.slice(0, 400)}`);
  return JSON.parse(raw.slice(start)) as T;
}

export function bbJson<T>(args: readonly string[]): T {
  return asJson<T>(run([...args, "--json"]));
}

/** The project a bare `bb thread spawn` should use: the one this run is started from. */
export function statusProject(): string {
  return bbJson<{ project: { id: string } }>(["status"]).project.id;
}

export function installedPlugin(id: string): InstalledPlugin | null {
  const listed = bbJson<{ plugins: InstalledPlugin[] }>(["plugin", "list"]).plugins;
  return listed.find((plugin) => plugin.id === id) ?? null;
}

export function providerModels(providerId: string): CatalogModel[] {
  return bbJson<CatalogModel[]>(["provider", "models", providerId]);
}

export function spawnThread(input: { prompt: string; environment: string; title: string; project: string }): string {
  const spawned = bbJson<{ thread?: { id: string }; id?: string }>([
    "thread",
    "spawn",
    "--prompt",
    input.prompt,
    "--environment",
    input.environment,
    "--project",
    input.project,
    "--visibility",
    "hidden",
    "--title",
    input.title,
  ]);
  const id = spawned.id ?? spawned.thread?.id;
  if (!id) throw new Error(`bb thread spawn returned no thread id: ${JSON.stringify(spawned).slice(0, 400)}`);
  return id;
}

/** Every event of a thread, oldest first; `--all` pages through the log. */
export function threadEvents(threadId: string): ThreadEvent[] {
  return bbJson<ThreadEvent[]>(["thread", "log", threadId, "--all"]);
}

export function threadExists(threadId: string): boolean {
  try {
    run(["thread", "show", threadId]);
    return true;
  } catch {
    return false;
  }
}

/** Archives a thread this run spawned, and says whether it worked. */
export function archiveThread(threadId: string): boolean {
  try {
    run(["thread", "archive", threadId]);
    return true;
  } catch {
    return false;
  }
}
