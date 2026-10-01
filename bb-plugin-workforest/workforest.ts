import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { z } from "zod";
import {
  detailSchema,
  inventorySchema,
  operationSchema,
  previewSchema,
  templateSchema,
  type Detail,
  type Operation,
} from "./contracts.js";

const MAX_BYTES = 2 * 1024 * 1024;
export function runCommand(
  args: string[],
  options: {
    cwd?: string;
    signal: AbortSignal;
    timeoutMs?: number;
    executable?: string;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    options.signal.throwIfAborted();
    const child = spawn(options.executable ?? "wf", args, {
      cwd: options.cwd ?? homedir(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        CI: "1",
        TERM: "dumb",
      },
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      failure: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    function kill(signal: NodeJS.Signals) {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* The process may have exited between the event and cancellation. */
      }
    }
    function stop(error: Error) {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1000);
      killTimer.unref();
    }
    const abort = () =>
      stop(
        new Error(
          "Workforest command cancelled. Refresh status before retrying; completed filesystem changes are not rolled back.",
        ),
      );
    options.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        stop(
          new Error(
            "Workforest command timed out. Refresh status before retrying.",
          ),
        ),
      options.timeoutMs ?? 24000,
    );
    const receive = (data: Buffer, channel: "stdout" | "stderr") => {
      bytes += data.length;
      if (bytes > MAX_BYTES) {
        stop(
          new Error(
            "Workforest output exceeded 2 MiB. Inspect the command locally.",
          ),
        );
        return;
      }
      if (channel === "stdout") stdout += data.toString();
      else stderr += data.toString();
    };
    child.stdout.on("data", (data: Buffer) => receive(data, "stdout"));
    child.stderr.on("data", (data: Buffer) => receive(data, "stderr"));
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(
        new Error(
          `Cannot run Workforest on this machine. Install wf and make it available on the BB daemon PATH. ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error((stderr || stdout || `wf exited ${code}`).slice(-16000)),
        );
      else resolve(stdout);
    });
  });
}

export function parseEnvelope<T>(text: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      "Workforest returned non-JSON output. Update wf to a version supporting this command's --json contract.",
    );
  }
  const envelope = z
    .object({
      ok: z.boolean(),
      data: z.unknown().optional(),
      error: z.object({ message: z.string() }).optional(),
    })
    .parse(value);
  if (!envelope.ok)
    throw new Error(envelope.error?.message ?? "Workforest command failed");
  const result = schema.safeParse(envelope.data);
  if (!result.success)
    throw new Error(
      `Unsupported Workforest response: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  return result.data;
}

export function resolveCheckout(detail: Detail, requestedPath: string): string {
  const paths = [
    detail.path,
    ...detail.repositories.map((repo) => repo.path),
    ...detail.tasks.map((task) => task.path),
  ];
  if (!paths.includes(requestedPath))
    throw new Error(
      "Checkout is no longer part of this Workforest entry. Refresh and select it again.",
    );
  return requestedPath;
}

export function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);
}

export function buildOperation(
  operation: Operation,
  detail?: Detail,
): { args: string[]; cwd?: string } {
  const op = operationSchema.parse(operation);
  if (op.kind === "create") {
    if (
      op.sources.some((source) => source.startsWith("@")) &&
      op.sources.length !== 1
    )
      throw new Error(
        "Choose one template or one or more repositories, not both.",
      );
    return { args: ["new", op.name, ...op.sources] };
  }
  if (!detail || detail.selector !== op.selector)
    throw new Error("Workforest entry could not be resolved.");
  if (op.kind === "task") {
    const repo = detail.repositories.find(
      (repo) => repo.name === op.repository,
    );
    if (!repo) throw new Error("Repository is not part of this workspace.");
    if (repo.dirty.total > 0)
      throw new Error(
        "Commit the parent repository's changes before creating a task lane.",
      );
    return {
      args: ["task", "new", op.name, ...(op.setup ? ["--setup"] : [])],
      cwd: repo.path,
    };
  }
  return { args: ["init", op.kind, op.selector], cwd: detail.path };
}

export function createWorkforest(signal: AbortSignal) {
  const run = (args: string[]) => runCommand(args, { signal });
  return {
    inventory: async () =>
      parseEnvelope(await run(["list", "--json"]), inventorySchema),
    templates: async () =>
      parseEnvelope(
        await run(["template", "list", "--json"]),
        z.object({ templates: z.array(templateSchema) }),
      ).templates,
    detail: async (selector: string) =>
      parseEnvelope(await run(["status", selector, "--json"]), detailSchema),
    preview: async (selector: string) =>
      parseEnvelope(
        await run(["delete", selector, "--dry-run", "--json"]),
        previewSchema,
      ),
    logs: async (selector: string) => ({
      text: (await run(["init", "logs", selector])).slice(-24000),
    }),
  };
}
