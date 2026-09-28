import { createHash } from "node:crypto";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { dynamicEntriesSchema, type DynamicEntry } from "./contract.js";

export function createDynamicStore(storage: PluginKvStorage) {
  let pending: Promise<unknown> = Promise.resolve();
  async function list() {
    const entries = dynamicEntriesSchema.parse(
      (await storage.get<unknown>("entries")) ?? [],
    );
    return {
      entries,
      revision: createHash("sha256")
        .update(JSON.stringify(entries))
        .digest("hex"),
    };
  }
  function mutate(
    revision: string,
    update: (entries: DynamicEntry[]) => DynamicEntry[],
  ) {
    const operation = pending.then(async () => {
      const current = await list();
      if (current.revision !== revision)
        throw new Error(
          "Dynamic variables changed. Reload the list before saving.",
        );
      const entries = dynamicEntriesSchema.parse(update(current.entries));
      if (Buffer.byteLength(JSON.stringify(entries)) > 240 * 1024)
        throw new Error("Dynamic configuration exceeds the storage limit.");
      await storage.set("entries", entries);
      return list();
    });
    pending = operation.catch(() => undefined);
    return operation;
  }
  return {
    list,
    save(originalName: string | null, entry: DynamicEntry, revision: string) {
      return mutate(revision, (entries) => {
        if (
          originalName !== null &&
          !entries.some((item) => item.name === originalName)
        )
          throw new Error("Variable no longer exists. Reload the list.");
        if (
          entries.some(
            (item) => item.name === entry.name && item.name !== originalName,
          )
        )
          throw new Error(`Variable ${entry.name} already exists.`);
        return originalName === null
          ? [...entries, entry]
          : entries.map((item) => (item.name === originalName ? entry : item));
      });
    },
    remove(name: string, revision: string) {
      return mutate(revision, (entries) =>
        entries.filter((entry) => entry.name !== name),
      );
    },
  };
}
