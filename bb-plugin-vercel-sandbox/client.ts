import { Sandbox } from "@vercel/sandbox";
import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  SafeError,
  type Credentials,
  type LaunchInputs,
} from "./configuration.js";
import { IMAGE } from "./provider-id.js";
import { z } from "zod";
import type { Resource } from "./allocations.js";
import { stateSchema } from "./rpc.js";

function notFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "response" in error &&
    error.response instanceof Response &&
    error.response.status === 404 &&
    "json" in error &&
    typeof error.json === "object" &&
    error.json !== null &&
    "error" in error.json &&
    typeof error.json.error === "object" &&
    error.json.error !== null &&
    "code" in error.json.error &&
    ["not_found", "sandbox_not_found"].includes(String(error.json.error.code))
  );
}

export function createVercelClient(
  settings: Credentials,
  transport: typeof fetch,
  refresh: (signal: AbortSignal) => Promise<Credentials>,
) {
  let current = settings;
  const scopedFetch: typeof fetch = async (input, init) => {
    const mutating = (init?.method ?? "GET") !== "GET";
    try {
      if (current.expiresAt <= Date.now() + 30_000) {
        const refreshed = await refresh(
          init?.signal ?? AbortSignal.timeout(60_000),
        );
        if (
          refreshed.teamId !== settings.teamId ||
          refreshed.projectId !== settings.projectId ||
          refreshed.expiresAt <= Date.now() + 30_000
        )
          throw new SafeError(
            "Refreshed OIDC credentials do not match the pinned allocation.",
          );
        current = refreshed;
      }
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${current.token}`);
      const url = new URL(String(input));
      if (
        url.origin !== "https://vercel.com" ||
        url.searchParams.get("teamId") !== settings.teamId
      )
        throw new SafeError(
          "Vercel request scope does not match the pinned connection.",
        );
      const response = await transport(input, { ...init, headers });
      if (mutating && (response.status === 429 || response.status >= 500)) {
        throw new DOMException(
          "Vercel mutation outcome is uncertain",
          "AbortError",
        );
      }
      return response;
    } catch (error) {
      if (mutating)
        throw new DOMException(
          "Vercel mutation outcome is uncertain",
          "AbortError",
        );
      throw error;
    }
  };
  const credentials = {
    token: "bb-host-oidc",
    teamId: settings.teamId,
    projectId: settings.projectId,
    fetch: scopedFetch,
  };
  const sessionResponse = z.object({
    session: z.object({
      id: z.string(),
      projectId: z.string(),
      sourceSandboxName: z.string(),
      status: stateSchema.exclude(["missing"]),
    }),
  });
  const sessionRequest = async (
    resource: Resource,
    signal: AbortSignal,
    stop: boolean,
  ) => {
    if (resource.sessionId === null)
      throw new SafeError(
        "Vercel session identity is unavailable; retain the allocation record for investigation.",
      );
    const url = new URL(
      `https://vercel.com/api/v2/sandboxes/sessions/${encodeURIComponent(resource.sessionId)}${stop ? "/stop" : ""}`,
    );
    url.searchParams.set("teamId", settings.teamId);
    const request = {
      method: stop ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${settings.token}`,
        "content-type": "application/json",
      },
      ...(stop ? { body: "{}" } : {}),
      signal,
    };
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await scopedFetch(url, request);
        if (
          stop ||
          (response.status !== 429 && response.status < 500) ||
          attempt === 2
        )
          break;
        await response.body?.cancel();
      } catch (error) {
        if (stop || attempt === 2 || signal.aborted) throw error;
      }
      await delay(400 * 2 ** attempt, undefined, { signal });
    }
    const body: unknown = await response.json();
    if (!stop && response.status === 404) {
      const missing = z
        .object({
          error: z.object({ code: z.enum(["not_found", "sandbox_not_found"]) }),
        })
        .safeParse(body);
      if (missing.success) return null;
    }
    if (!response.ok)
      throw new SafeError(
        "Vercel session observation or stop failed; retain the machine record and retry cleanup.",
      );
    const { session } = sessionResponse.parse(body);
    if (
      session.id !== resource.sessionId ||
      session.projectId !== resource.projectId ||
      session.sourceSandboxName !== resource.sandboxName
    )
      throw new SafeError(
        "Vercel session ownership does not match the recorded allocation; refusing cleanup.",
      );
    return session;
  };
  return {
    getSession: (resource: Resource, signal: AbortSignal) =>
      sessionRequest(resource, signal, false),
    stopSession: (resource: Resource, signal: AbortSignal) =>
      sessionRequest(resource, signal, true),
    async inspectAccount(signal: AbortSignal) {
      await Sandbox.list({ ...credentials, limit: 1, signal });
    },
    async get(name: string, signal: AbortSignal): Promise<Sandbox | null> {
      try {
        return await Sandbox.get({
          ...credentials,
          name,
          resume: false,
          signal,
        });
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async create(
      name: string,
      tags: Record<string, string>,
      inputs: LaunchInputs,
      signal: AbortSignal,
    ) {
      return Sandbox.create({
        ...credentials,
        name,
        tags,
        image: IMAGE,
        persistent: false,
        resources: { vcpus: inputs.vcpus },
        timeout: inputs.timeoutMinutes * 60_000,
        signal,
      });
    },
  };
}

export function sandboxExecutor(sandbox: Sandbox): MachineExecutor {
  const session = sandbox.currentSession();
  return {
    async exec(request) {
      request.signal.throwIfAborted();
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(request.timeoutMs + 10_000),
      ]);
      const inputPath = `/tmp/bb-bootstrap-${randomUUID()}`;
      let process: Awaited<ReturnType<typeof session.getCommand>> | undefined;
      try {
        await session.writeFiles(
          [{ path: inputPath, content: request.stdin, mode: 0o600 }],
          { signal },
        );
        signal.throwIfAborted();
        process = await session.runCommand({
          cmd: "sh",
          args: [
            "-c",
            'set -eu; exec 3<"$1"; rm -f -- "$1"; shift; exec "$@" <&3',
            "bb-bootstrap",
            inputPath,
            ...request.command,
          ],
          detached: true,
          timeoutMs: request.timeoutMs,
          signal,
        });
        let bytes = 0;
        const logs = process.logs({ signal });
        const stream = async () => {
          for await (const log of logs) {
            const data = Buffer.from(log.data);
            const remaining = 128 * 1024 - bytes;
            if (remaining > 0)
              request.onOutput(data.subarray(0, remaining).toString("utf8"));
            bytes += data.length;
          }
        };
        try {
          const [finished] = await Promise.all([
            process.wait({ signal }),
            stream(),
          ]);
          return { exitCode: finished.exitCode };
        } finally {
          logs.close();
        }
      } catch {
        if (process)
          await process
            .kill("SIGKILL", { abortSignal: AbortSignal.timeout(10_000) })
            .catch(() => {});
        request.signal.throwIfAborted();
        throw new SafeError(
          "Vercel bootstrap execution failed or timed out. Machine cleanup will remove the allocation.",
        );
      } finally {
        await session
          .runCommand({
            cmd: "rm",
            args: ["-f", "--", inputPath],
            timeoutMs: 10_000,
            signal: AbortSignal.timeout(10_000),
          })
          .catch(() => {});
      }
    },
  };
}
