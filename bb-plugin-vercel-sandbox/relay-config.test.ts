import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relaySettings } from "./relay-access/config.ts";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
it("moves the former managed secret into private storage without defining an editable setting", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-private-config-"));
  const t = createFakePluginHost({ pluginId: "environment-vercel-sandbox", dataDir: root });
  disposals.push(() => t.harness.lifecycle.dispose(), () => rm(root, { recursive: true, force: true }));
  const directory = join(root, "plugins/environment-vercel-sandbox/secrets");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const legacy = join(directory, "relayIdentity");
  await writeFile(legacy, JSON.stringify({ enabled: false, preparedConnectorPrivateKey: "synthetic-private-material" }), { mode: 0o600 });
  const settings = relaySettings(t.bb);
  expect(await settings.get()).toMatchObject({ enabled: false, preparedConnectorPrivateKey: "synthetic-private-material" });
  expect(t.harness.registrations.settingsDescriptors).toEqual({});
  expect(await t.bb.storage.kv.list()).toEqual([]);
  const db = t.bb.storage.database();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { expect((await stat(db.name + suffix)).mode & 0o777).toBe(0o600); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
  }
  let changed = 0;
  settings.onChange(async () => { changed++; });
  await settings.experimental_set({ enabled: true });
  await settings.experimental_set({ enabled: true });
  expect(changed).toBe(1);
  await writeFile(legacy, "invalid-stale-backup", { mode: 0o600 });
  const reloaded = await t.harness.lifecycle.reload(async bb => {
    expect(await relaySettings(bb).get()).toMatchObject({ enabled: true, preparedConnectorPrivateKey: "synthetic-private-material" });
  });
  expect(reloaded.harness.registrations.settingsDescriptors).toEqual({});
});

it("never turns malformed private data into a fresh default identity or exposes its contents", async () => {
  const t = createFakePluginHost({ pluginId: "environment-vercel-sandbox" });
  disposals.push(() => t.harness.lifecycle.dispose());
  const settings = relaySettings(t.bb);
  await settings.experimental_set({ preparedConnectorPrivateKey: "synthetic-private-material" });
  t.bb.storage.database().prepare("UPDATE private_relay_config SET config = ?").run("invalid-synthetic-private-material");
  await expect(settings.get()).rejects.toThrow("Private relay configuration could not be read");
  await expect(settings.get()).rejects.not.toThrow("invalid-synthetic-private-material");
});
