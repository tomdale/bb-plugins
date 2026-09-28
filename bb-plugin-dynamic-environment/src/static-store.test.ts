import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStaticStore } from "./static-store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bb-env-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const read = async () =>
  JSON.parse(await readFile(join(dir, "env.json"), "utf8"));

describe("env.json editor", () => {
  it("refuses a write that would exceed its own read limit", async () => {
    const original = JSON.stringify({
      env: { LARGE: "a".repeat(2 * 1024 * 1024 - 100) },
    });
    await writeFile(join(dir, "env.json"), original);
    const store = createStaticStore(dir);
    await expect(
      store.save(null, "NEW", "b".repeat(200), (await store.list()).revision),
    ).rejects.toThrow("too large");
    expect(await readFile(join(dir, "env.json"), "utf8")).toBe(original);
  });
  it("lists names without returning values or unkeyed secret hashes", async () => {
    await writeFile(
      join(dir, "env.json"),
      JSON.stringify({ env: { TOKEN: "do-not-return", PROTO_HOME: "/tools" } }),
    );
    const store = createStaticStore(dir);
    const state = await store.list();
    expect(state.names).toEqual(["PROTO_HOME", "TOKEN"]);
    expect(JSON.stringify(state)).not.toContain("do-not-return");
    expect((await createStaticStore(dir).list()).revision).not.toBe(
      state.revision,
    );
  });
  it("creates a missing file, preserves empty values and restricts permissions", async () => {
    const store = createStaticStore(dir);
    const state = await store.list();
    await store.save(null, "EMPTY", "", state.revision);
    expect(await read()).toEqual({ env: { EMPTY: "" } });
    expect((await stat(join(dir, "env.json"))).mode & 0o777).toBe(0o600);
  });
  it("renames without fetching secrets and preserves unrelated variables and metadata", async () => {
    await writeFile(
      join(dir, "env.json"),
      JSON.stringify({
        env: { TOKEN: " private \n", OTHER: "keep" },
        future: { x: true },
      }),
    );
    const store = createStaticStore(dir);
    const state = await store.list();
    await store.save("TOKEN", "RENAMED", null, state.revision);
    expect(await read()).toEqual({
      env: { RENAMED: " private \n", OTHER: "keep" },
      future: { x: true },
    });
  });
  it("rejects stale writes and leaves external edits intact", async () => {
    const store = createStaticStore(dir);
    const state = await store.list();
    await writeFile(join(dir, "env.json"), '{"env":{"EXTERNAL":"keep"}}');
    await expect(store.save(null, "A", "b", state.revision)).rejects.toThrow(
      "changed",
    );
    expect(await read()).toEqual({ env: { EXTERNAL: "keep" } });
  });
  it("does not clobber duplicate names or invent missing saved values", async () => {
    await writeFile(join(dir, "env.json"), '{"env":{"A":"a","B":"b"}}');
    const store = createStaticStore(dir);
    const state = await store.list();
    await expect(store.save("A", "B", null, state.revision)).rejects.toThrow(
      "already exists",
    );
    await expect(store.save(null, "NEW", null, state.revision)).rejects.toThrow(
      "Enter a value",
    );
    await expect(
      store.save("MISSING", "NEW", null, state.revision),
    ).rejects.toThrow("no longer exists");
    expect(await read()).toEqual({ env: { A: "a", B: "b" } });
  });
  it("removes just one variable", async () => {
    await writeFile(join(dir, "env.json"), '{"env":{"A":"a","B":"b"}}');
    const store = createStaticStore(dir);
    await store.remove("A", (await store.list()).revision);
    expect(await read()).toEqual({ env: { B: "b" } });
  });
  it.each([
    '{"env":{"A":123}}',
    '{"env": {"bad name":"secret"}}',
    '{"env": "sensitive malformed input"',
  ])(
    "rejects malformed files without exposing content: %s",
    async (content) => {
      await writeFile(join(dir, "env.json"), content);
      await expect(createStaticStore(dir).list()).rejects.toThrow(
        "not a valid environment file",
      );
      expect(await readFile(join(dir, "env.json"), "utf8")).toBe(content);
    },
  );
  it("refuses symlinks instead of replacing their targets", async () => {
    const target = join(dir, "target.json");
    await writeFile(target, '{"env":{}}');
    await symlink(target, join(dir, "env.json"));
    await expect(createStaticStore(dir).list()).rejects.toThrow("regular file");
  });
  it("serializes writers on BB's advisory lock and detects concurrent edits", async () => {
    const store = createStaticStore(dir);
    const state = await store.list();
    const results = await Promise.allSettled([
      store.save(null, "A", "a", state.revision),
      store.save(null, "B", "b", state.revision),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(Object.keys((await read()).env)).toHaveLength(1);
  });
  it("times out on an occupied core lock and leaves the file alone", async () => {
    const locks = createRequire(import.meta.url)("fs-native-extensions");
    const handle = await open(join(dir, ".env.json.lock"), "a+");
    const store = createStaticStore(dir, 30);
    const state = await store.list();
    expect(locks.tryLock(handle.fd)).toBe(true);
    try {
      await expect(store.save(null, "A", "a", state.revision)).rejects.toThrow(
        "busy",
      );
    } finally {
      locks.unlock(handle.fd);
      await handle.close();
    }
    expect((await store.list()).names).toEqual([]);
  });
});
