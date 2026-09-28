import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const fileSchema = z
  .object({
    env: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string())
      .optional(),
  })
  .passthrough();
const locksSchema = z.object({
  tryLock: z.custom<(fd: number) => boolean>(
    (value) => typeof value === "function",
  ),
  unlock: z.custom<(fd: number) => void>(
    (value) => typeof value === "function",
  ),
});
function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createStaticStore(dataDir: string, lockTimeoutMs = 5_000) {
  const path = join(dataDir, "env.json");
  const revisionKey = randomBytes(32);
  async function read() {
    let raw: string | null = null;
    try {
      const info = await lstat(path);
      if (!info.isFile())
        throw new Error(
          "env.json must be a regular file; edit its symlink target outside this plugin.",
        );
      if (info.size > MAX_FILE_BYTES)
        throw new Error("env.json is too large to edit here.");
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    let file: z.infer<typeof fileSchema>;
    try {
      file = raw === null ? {} : fileSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error(
        "env.json is not a valid environment file. Fix it on disk before editing here.",
      );
    }
    const revision = createHmac("sha256", revisionKey)
      .update(raw === null ? "missing" : `file:${raw}`)
      .digest("hex");
    return { file, revision };
  }
  async function list() {
    const { file, revision } = await read();
    return { names: Object.keys(file.env ?? {}).sort(), revision, path };
  }
  async function mutate(
    revision: string,
    update: (env: Map<string, string>) => void,
  ) {
    // Share BB's advisory lock so launcher writes and plugin writes cannot clobber one another.
    const locks = locksSchema.parse(
      createRequire(import.meta.url)("fs-native-extensions"),
    );
    const handle = await open(join(dataDir, ".env.json.lock"), "a+", 0o600);
    let locked = false;
    const temp = join(dataDir, `.env.json.${randomUUID()}.tmp`);
    try {
      const deadline = performance.now() + lockTimeoutMs;
      while (!(locked = locks.tryLock(handle.fd))) {
        if (performance.now() >= deadline)
          throw new Error(
            "env.json is busy. Retry after the other BB command finishes.",
          );
        await setTimeout(25);
      }
      const current = await read();
      if (current.revision !== revision)
        throw new Error("env.json changed. Reload the list before saving.");
      const env = new Map(Object.entries(current.file.env ?? {}));
      update(env);
      const next = { ...current.file, env: Object.fromEntries(env) };
      const encoded = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(encoded) > MAX_FILE_BYTES)
        throw new Error(
          "The change would make env.json too large to edit here.",
        );
      await writeFile(temp, encoded, {
        flag: "wx",
        mode: 0o600,
      });
      // Detect intervening editor saves; only cooperating writers are protected through rename.
      if ((await read()).revision !== revision)
        throw new Error("env.json changed. Reload the list before saving.");
      await rename(temp, path);
      return await list();
    } finally {
      await unlink(temp).catch(() => undefined);
      try {
        if (locked) locks.unlock(handle.fd);
      } finally {
        await handle.close();
      }
    }
  }
  return {
    list,
    save(
      originalName: string | null,
      name: string,
      value: string | null,
      revision: string,
    ) {
      return mutate(revision, (env) => {
        if (originalName !== null && !env.has(originalName))
          throw new Error("Variable no longer exists. Reload the list.");
        if (name !== originalName && env.has(name))
          throw new Error(`Variable ${name} already exists.`);
        const saved = originalName === null ? undefined : env.get(originalName);
        const next = value ?? saved;
        if (next === undefined)
          throw new Error("Enter a value for the new variable.");
        if (originalName !== null) env.delete(originalName);
        env.set(name, next);
      });
    },
    remove(name: string, revision: string) {
      return mutate(revision, (env) => {
        env.delete(name);
      });
    },
  };
}
