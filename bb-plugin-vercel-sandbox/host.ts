import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { Sandbox } from "@vercel/sandbox";
import {
  allocationTags,
  assertOwnership,
  assertScope,
  type Resource,
} from "./allocations.js";
import { cliAuthentication, type CliRunner } from "./cli-auth.js";
import { createVercelClient, sandboxExecutor } from "./client.js";
import { SafeError, safeMessage } from "./configuration.js";
import { hostContract } from "./host-contract.js";
import { IMAGE } from "./provider-id.js";
import type { Connection } from "./auth-contract.js";

function view(sandbox: Sandbox) {
  return {
    name: sandbox.name,
    persistent: sandbox.persistent,
    tags: sandbox.tags ?? null,
    status: sandbox.status,
    sessionId: sandbox.currentSession().sessionId,
    sessionStatus: sandbox.currentSession().status,
    expiresAt: sandbox.expiresAt?.getTime() ?? null,
    vcpus: sandbox.vcpus ?? sandbox.currentSession().vcpus,
    memory: sandbox.memory ?? sandbox.currentSession().memory,
    image: sandbox.image ?? IMAGE,
  };
}
export function createVercelHostEntry(
  transport: typeof fetch,
  run?: CliRunner,
) {
  const auth = cliAuthentication(run);
  const guarded = async <T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; message: string }> => {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      signal.throwIfAborted();
      return { ok: false, message: safeMessage(error) };
    }
  };
  const client = async (
    input: { connection: Connection; resource: Resource },
    signal: AbortSignal,
  ) => {
    assertScope(input.resource, input.connection);
    if (
      input.resource.connection &&
      JSON.stringify(input.resource.connection) !==
        JSON.stringify(input.connection)
    )
      throw new SafeError(
        "The authentication connection does not match this allocation's original machine and account.",
      );
    return createVercelClient(
      await auth.credentials(input.connection, signal),
      transport,
      (signal) => auth.credentials(input.connection, signal),
    );
  };
  const owned = async (
    input: { connection: Connection; resource: Resource },
    signal: AbortSignal,
  ) => {
    const vendor = await client(input, signal);
    const sandbox = await vendor.get(input.resource.sandboxName, signal);
    if (!sandbox)
      throw new SafeError(
        "Vercel named allocation is missing; retain its record and inspect the original session before cleanup.",
      );
    assertOwnership(input.resource, sandbox);
    return sandbox;
  };
  return experimental_defineHostEntry({
    contract: hostContract,
    handlers: {
      connect: (input, context) =>
        guarded(context.signal, async () => {
          const { connection } = await auth.connect(input, context.signal);
          const credentials = await auth.credentials(
            connection,
            context.signal,
          );
          await createVercelClient(credentials, transport, (signal) =>
            auth.credentials(connection, signal),
          ).inspectAccount(context.signal);
          return { connection, accountName: credentials.accountName };
        }),
      inspect: (connection, context) =>
        guarded(context.signal, async () => {
          const credentials = await auth.credentials(
            connection,
            context.signal,
          );
          await createVercelClient(credentials, transport, (signal) =>
            auth.credentials(connection, signal),
          ).inspectAccount(context.signal);
          return { accountName: credentials.accountName };
        }),
      get: (input, context) =>
        guarded(context.signal, async () => {
          const sandbox = await (
            await client(input, context.signal)
          ).get(input.resource.sandboxName, context.signal);
          return sandbox ? view(sandbox) : null;
        }),
      create: (input, context) =>
        guarded(context.signal, async () =>
          view(
            await (
              await client(input, context.signal)
            ).create(
              input.resource.sandboxName,
              allocationTags(input.resource),
              input.resource.inputs,
              context.signal,
            ),
          ),
        ),
      getSession: (input, context) =>
        guarded(context.signal, async () =>
          (await client(input, context.signal)).getSession(
            input.resource,
            context.signal,
          ),
        ),
      stopSession: (input, context) =>
        guarded(context.signal, async () => {
          await (
            await client(input, context.signal)
          ).stopSession(input.resource, context.signal);
          return {};
        }),
      stop: (input, context) =>
        guarded(context.signal, async () => {
          await (
            await owned(input, context.signal)
          )
            .currentSession()
            .stop({ signal: context.signal });
          return {};
        }),
      delete: (input, context) =>
        guarded(context.signal, async () => {
          await (
            await owned(input, context.signal)
          ).delete({ deleteOrphanSnapshots: true, signal: context.signal });
          return {};
        }),
      exec: (input, context) =>
        guarded(context.signal, async () => {
          const sandbox = await owned(input, context.signal);
          let output = "";
          const result = await sandboxExecutor(sandbox).exec({
            ...input,
            signal: context.signal,
            onOutput: (chunk) => {
              output += chunk;
            },
          });
          return { ...result, output };
        }),
    },
  });
}
export default createVercelHostEntry(globalThis.fetch);
