import { open, readFile, rename, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { fresh } from "./protocol.ts";
export const JOURNAL_LIMIT = 1024 * 1024;

// Atomic replacement plus fsync for one local writer, not a transactional distributed store.
export class AtomicFile<T> {
  constructor(readonly path: string, readonly empty: T) {}
  async load(): Promise<T> {
    try {
      if ((await stat(this.path)).size > JOURNAL_LIMIT) throw new Error("Journal size limit");
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(this.empty);
      throw error;
    }
  }
  async save(state: T): Promise<void> {
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > JOURNAL_LIMIT) throw new Error("Journal size limit");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${fresh()}.tmp`;
    try {
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
      const directory = await open(dirname(this.path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
  }
}
