import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { SafeError } from "./configuration.js";
import type { Connection } from "./auth-contract.js";
import type { Resource } from "./allocations.js";
import { hostContract, sandboxViewSchema } from "./host-contract.js";

export function remoteVercelClient(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const options = (
    connection: Connection,
    signal: AbortSignal,
    timeoutMs = 60_000,
  ) => ({ hostId: connection.hostId, signal, timeoutMs });
  const unwrap = async <T>(
    pending: Promise<{ ok: true; value: T } | { ok: false; message: string }>,
  ): Promise<T> => {
    const result = await pending;
    if (!result.ok) throw new SafeError(result.message);
    return result.value;
  };
  return {
    connect: (
      input: { hostId: string; directory: string },
      signal: AbortSignal,
    ) =>
      unwrap(
        host.call("connect", input, {
          hostId: input.hostId,
          signal,
          timeoutMs: 60_000,
        }),
      ),
    inspect: (connection: Connection, signal: AbortSignal) =>
      unwrap(host.call("inspect", connection, options(connection, signal))),
    forResource(connection: Connection, resource: Resource) {
      const wrap = (value: z.infer<typeof sandboxViewSchema>) => {
        const observed = { ...resource, sessionId: value.sessionId };
        return {
          ...value,
          tags: value.tags ?? undefined,
          expiresAt:
            value.expiresAt === null ? null : new Date(value.expiresAt),
          currentSession: () => ({
            sessionId: value.sessionId,
            status: value.sessionStatus,
            stop: ({ signal }: { signal: AbortSignal }) =>
              unwrap(
                host.call(
                  "stop",
                  { connection, resource: observed },
                  options(connection, signal),
                ),
              ),
          }),
          delete: ({
            signal,
          }: {
            signal: AbortSignal;
            deleteOrphanSnapshots: boolean;
          }) =>
            unwrap(
              host.call(
                "delete",
                { connection, resource: observed },
                options(connection, signal),
              ),
            ),
          executor: {
            async exec(request) {
              const result = await unwrap(
                host.call(
                  "exec",
                  {
                    connection,
                    resource: observed,
                    command: request.command,
                    stdin: request.stdin,
                    timeoutMs: request.timeoutMs,
                  },
                  options(
                    connection,
                    request.signal,
                    request.timeoutMs + 30_000,
                  ),
                ),
              );
              request.onOutput(result.output);
              return { exitCode: result.exitCode };
            },
          } satisfies MachineExecutor,
        };
      };
      return {
        async get(_name: string, signal: AbortSignal) {
          const value = await unwrap(
            host.call(
              "get",
              { connection, resource },
              options(connection, signal),
            ),
          );
          return value ? wrap(value) : null;
        },
        async create(
          _name: string,
          _tags: Record<string, string>,
          _inputs: Resource["inputs"],
          signal: AbortSignal,
        ) {
          return wrap(
            await unwrap(
              host.call(
                "create",
                { connection, resource },
                options(connection, signal, 180_000),
              ),
            ),
          );
        },
        getSession: (resource: Resource, signal: AbortSignal) =>
          unwrap(
            host.call(
              "getSession",
              { connection, resource },
              options(connection, signal),
            ),
          ),
        stopSession: (resource: Resource, signal: AbortSignal) =>
          unwrap(
            host.call(
              "stopSession",
              { connection, resource },
              options(connection, signal),
            ),
          ),
      };
    },
  };
}
