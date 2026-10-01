import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  resolvedInputsSchema,
  scopeSchema,
  SafeError,
} from "./configuration.js";
import { connectionSchema, type Connection } from "./auth-contract.js";
import type { Sandbox } from "@vercel/sandbox";
import { PROVIDER_ID } from "./provider-id.js";

export const resourceSchema = scopeSchema
  .extend({
    version: z.literal(1),
    connection: connectionSchema.optional(),
    owner: z.string().uuid(),
    generation: z.string().uuid(),
    key: z.string().min(1).max(200),
    sandboxName: z.string().regex(/^bb-[a-f0-9]{48}$/),
    sessionId: z.string().min(1).nullable(),
    expiresAt: z.number().finite().nullable(),
    inputs: resolvedInputsSchema,
  })
  .strict();
export type Resource = z.infer<typeof resourceSchema>;
const intentSchema = z
  .object({
    phase: z.enum([
      "prepared",
      "submitted",
      "allocated",
      "stopping",
      "stop-accepted",
      "deleting",
      "removed",
    ]),
    resource: resourceSchema,
  })
  .strict();
export type Intent = z.infer<typeof intentSchema>;
const digest = (key: string) => createHash("sha256").update(key).digest("hex");
export const allocationTags = (resource: Resource) => ({
  bbOwner: resource.owner,
  bbKey: digest(resource.key),
  bbProvider: PROVIDER_ID,
  bbGeneration: resource.generation,
});
export const allocationName = (owner: string, key: string) =>
  `bb-${digest(JSON.stringify([owner, key])).slice(0, 48)}`;

const operations = new Map<string, Promise<unknown>>();

export async function allocationStore(bb: Pick<BbPluginApi, "storage">) {
  const stored = await bb.storage.kv.get<unknown>("owner");
  const owner =
    stored === undefined ? randomUUID() : z.string().uuid().parse(stored);
  if (stored === undefined) await bb.storage.kv.set("owner", owner);
  const storageKey = (key: string) => `allocations/${digest(key)}`;
  async function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const lockKey = JSON.stringify([owner, key]);
    const previous = operations.get(lockKey) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(task);
    operations.set(lockKey, operation);
    try {
      return await operation;
    } finally {
      if (operations.get(lockKey) === operation) operations.delete(lockKey);
    }
  }

  return {
    owner,
    run,
    async legacyAllocations(connection: Connection) {
      const candidates = await Promise.all(
        (await bb.storage.kv.list("allocations/")).map(async (key) => {
          const intent = intentSchema.parse(
            await bb.storage.kv.get<unknown>(key),
          );
          if (
            intent.resource.owner !== owner ||
            key !== storageKey(intent.resource.key) ||
            intent.resource.sandboxName !==
              allocationName(owner, intent.resource.key)
          )
            throw new SafeError(
              "An allocation has invalid ownership; investigate before authorizing CLI migration.",
            );
          return intent;
        }),
      );
      return candidates.filter(
        ({ phase, resource }) =>
          phase !== "removed" &&
          !resource.connection &&
          resource.teamId === connection.teamId &&
          resource.projectId === connection.projectId,
      );
    },
    async bindConnection(
      connection: Connection,
      expectedCount: number,
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      const candidates = (await this.legacyAllocations(connection)).sort(
        (a, b) => a.resource.key.localeCompare(b.resource.key),
      );
      let adopted = 0;
      try {
        if (candidates.length !== expectedCount)
          throw new SafeError(
            "The inspected allocation count changed. Reinspect before authorizing adoption.",
          );
        const lock = async (index: number): Promise<void> => {
          const candidate = candidates[index];
          if (candidate)
            return run(candidate.resource.key, () => lock(index + 1));
          signal.throwIfAborted();
          const current = await this.legacyAllocations(connection);
          if (
            current.length !== candidates.length ||
            candidates.some(
              (candidate) =>
                !current.some(
                  (intent) =>
                    intent.resource.key === candidate.resource.key &&
                    intent.resource.generation ===
                      candidate.resource.generation,
                ),
            )
          )
            throw new SafeError(
              "The inspected allocations changed. Reinspect before authorizing adoption.",
            );
          for (const candidate of candidates) {
            const key = storageKey(candidate.resource.key);
            const intent = intentSchema.parse(
              await bb.storage.kv.get<unknown>(key),
            );
            if (
              intent.phase === "removed" ||
              intent.resource.connection ||
              intent.resource.generation !== candidate.resource.generation ||
              intent.resource.teamId !== connection.teamId ||
              intent.resource.projectId !== connection.projectId
            )
              throw new SafeError(
                "The inspected allocations changed. Reinspect before authorizing adoption.",
              );
            signal.throwIfAborted();
            await bb.storage.kv.set(key, {
              ...intent,
              resource: { ...intent.resource, connection },
            });
            adopted++;
          }
        };
        await lock(0);
      } catch {
        throw new SafeError(
          `CLI migration was interrupted after ${adopted} confirmed allocation bindings. The default connection was not changed. Reinspect the recorded allocations before retrying; confirmed bindings retain their authorized account.`,
        );
      }
      return adopted;
    },
    async get(key: string): Promise<Intent | null> {
      const value = await bb.storage.kv.get<unknown>(storageKey(key));
      return value === undefined ? null : intentSchema.parse(value);
    },
    async set(intent: Intent) {
      await bb.storage.kv.set(storageKey(intent.resource.key), intent);
    },
    parse(value: unknown): Resource {
      const parsed = resourceSchema.safeParse(value);
      if (!parsed.success)
        throw new SafeError(
          "Vercel machine resource is invalid; cleanup requires operator investigation.",
        );
      const resource = parsed.data;
      if (
        resource.owner !== owner ||
        resource.sandboxName !== allocationName(owner, resource.key)
      )
        throw new SafeError(
          "Vercel machine belongs to a different BB server allocation namespace.",
        );
      return resource;
    },
  };
}
export function assertScope(
  resource: Resource,
  settings: { teamId: string; projectId: string },
) {
  if (
    resource.teamId !== settings.teamId ||
    resource.projectId !== settings.projectId
  )
    throw new SafeError(
      "Restore this machine's original CLI-linked Vercel team and project before inspection or cleanup.",
    );
}
export function assertOwnership(
  resource: Resource,
  sandbox: Pick<Sandbox, "name" | "persistent" | "tags"> & {
    currentSession(): { sessionId: string };
  },
) {
  const tags = allocationTags(resource);
  if (
    sandbox.name !== resource.sandboxName ||
    sandbox.persistent ||
    Object.entries(tags).some(([key, value]) => sandbox.tags?.[key] !== value)
  )
    throw new SafeError(
      "Vercel allocation ownership does not match this BB machine; refusing access or deletion.",
    );
  if (
    resource.sessionId !== null &&
    sandbox.currentSession().sessionId !== resource.sessionId
  )
    throw new SafeError(
      "Vercel allocation session changed; refusing to replace or delete unrelated compute.",
    );
}
export function observedResource(
  resource: Resource,
  sandbox: { expiresAt: Date | null; currentSession(): { sessionId: string } },
): Resource {
  return {
    ...resource,
    sessionId: sandbox.currentSession().sessionId,
    expiresAt: sandbox.expiresAt?.getTime() ?? resource.expiresAt,
  };
}
