import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "./server.js";
import { contract } from "./src/contract.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-env-plugin-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const { bb, harness } = createFakePluginHost({
    pluginId: "dynamic-environment",
    dataDir,
  });
  cleanups.push(() => harness.lifecycle.dispose());
  await plugin(bb);
  return { bb, harness, dataDir };
}

describe("plugin configuration", () => {
  it.each(["codex", "claude-code", "pi"])(
    "contributes values accepted by the host contract for %s",
    async (providerId) => {
      const { bb, harness } = await setup();
      await bb.storage.kv.set("entries", [
        { name: "TEST_GATEWAY_KEY", command: "printf test-only" },
      ]);
      const values = await harness.resolveProviderEnv(providerId, {
        threadId: "test-thread",
        projectId: "test-project",
        hostId: "test-host",
      });
      expect(values).toEqual([
        {
          name: "TEST_GATEWAY_KEY",
          value: "test-only",
          reason: "Dynamic environment command",
        },
      ]);
    },
  );
  it("retains the migrated command across reload and exposes no raw settings form", async () => {
    const { bb, harness } = await setup();
    await bb.storage.kv.set("entries", [
      { name: "TOKEN", command: "printf value" },
    ]);
    const next = await harness.lifecycle.reload(plugin);
    cleanups.push(() => next.harness.lifecycle.dispose());
    const result = await next.harness.behavior.callRpc("dynamicList", {});
    expect(JSON.stringify(result)).toContain("printf value");
    expect(next.harness.registrations.settingsDescriptors).toEqual({});
    expect(
      await next.harness.behavior.runCli(["list", "--json"]),
    ).toMatchObject({
      exitCode: 0,
      stdout: '[{"name":"TOKEN","command":"printf value"}]\n',
    });
  });
  it("uses the same storage for CLI and forms, renames, validates duplicates and stale updates", async () => {
    const { bb, harness } = await setup();
    await harness.behavior.runCli(["set", "TOKEN", "printf secret"]);
    const { createDynamicStore } = await import("./src/dynamic-store.js");
    const store = createDynamicStore(bb.storage.kv);
    const state = await store.list();
    const result = await harness.behavior.callRpc("dynamicSave", {
      originalName: "TOKEN",
      entry: { name: "RENAMED", command: "printf new" },
      revision: state.revision,
    });
    expect(result).toMatchObject({
      entries: [{ name: "RENAMED", command: "printf new" }],
    });
    await expect(
      harness.behavior.callRpc("dynamicRemove", {
        name: "RENAMED",
        revision: state.revision,
      }),
    ).rejects.toThrow("changed");
    const next = await store.list();
    await expect(
      harness.behavior.callRpc("dynamicSave", {
        originalName: null,
        entry: next.entries[0],
        revision: next.revision,
      }),
    ).rejects.toThrow("already exists");
    expect(next.entries).toEqual([{ name: "RENAMED", command: "printf new" }]);
    await expect(
      harness.behavior.callRpc("dynamicSave", {
        originalName: null,
        entry: { name: "INVALID NAME", command: "x" },
        revision: next.revision,
      }),
    ).rejects.toThrow();
  });
  it("rejects two concurrent saves against the same revision", async () => {
    const { bb } = await setup();
    const { createDynamicStore } = await import("./src/dynamic-store.js");
    const store = createDynamicStore(bb.storage.kv);
    const { revision } = await store.list();
    const results = await Promise.allSettled([
      store.save(null, { name: "A", command: "a" }, revision),
      store.save(null, { name: "B", command: "b" }, revision),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
  });
  it("static CLI output contains names but never values, and leaves other data intact", async () => {
    const { harness, dataDir } = await setup();
    await writeFile(
      join(dataDir, "env.json"),
      '{"env":{"KEEP":"sensitive"},"future":true}',
    );
    expect(
      (await harness.behavior.runCli(["static-set", "NEW", " secret "]))
        .exitCode,
    ).toBe(0);
    const result = await harness.behavior.runCli(["static-list", "--json"]);
    expect(result.stdout).toBe('["KEEP","NEW"]\n');
    expect(
      JSON.parse(await readFile(join(dataDir, "env.json"), "utf8")),
    ).toEqual({ env: { KEEP: "sensitive", NEW: " secret " }, future: true });
    expect(
      (await harness.behavior.runCli(["static-remove", "NEW"])).exitCode,
    ).toBe(0);
  });
  it("preserves CLI arguments named --json rather than filtering command/value text", async () => {
    const { harness } = await setup();
    expect(
      (await harness.behavior.runCli(["set", "FLAG", "--json"])).exitCode,
    ).toBe(0);
    expect((await harness.behavior.runCli(["list"])).stdout).toContain(
      '"command": "--json"',
    );
  });
  it("rejects NULs and unknown RPC fields before mutation", () => {
    expect(() =>
      contract.staticSave.input.parse({
        name: "X",
        value: "a\0b",
        originalName: null,
        revision: "r",
      }),
    ).toThrow();
    expect(() =>
      contract.staticList.input.parse({ path: "/etc/elsewhere" }),
    ).toThrow();
    expect(() =>
      contract.dynamicSave.input.parse({
        originalName: null,
        entry: { name: "A", command: " " },
        revision: "r",
      }),
    ).toThrow();
  });
});
