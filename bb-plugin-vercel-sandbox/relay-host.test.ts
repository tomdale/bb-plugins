import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { Sandbox } from "@vercel/sandbox";
import { relayOperation, relayName, relayTags, verifyRelayArtifact } from "./relay-host.js";
import { relayIdentitySchema, type RelayIdentity } from "./relay-contract.js";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createVercelHostEntry } from "./host.js";
import { cliFixture } from "./cli-test-fixture.js";

const disposals: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of disposals.splice(0)) await fn(); });
const image = "vercel/sandbox/node:24";
const identity = (): RelayIdentity => ({ owner: randomUUID(), generation: randomUUID(), key: "synthetic-relay", image,
  authorizedKey: `ssh-ed25519 ${Buffer.alloc(51).toString("base64")}`, bridgePort: 38991,
  connection: { hostId: "host_auth", accountId: "account_test", teamId: "team_test", projectId: "prj_test", directory: null } });
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "relay-fake-cloud-"));
  disposals.push(() => rm(dataDir, { recursive: true, force: true }));
  const id = identity();
  let present = false, stopped = false;
  let creates = 0, launches = 0, deletes = 0, stops = 0;
  let firstDispatch = true;
  let createReplyLost = false, launchReplyLost = false, stopReplyLost = false, deleteReplyLost = false;
  let sessionMissing = false, commandExited = false;
  let submittedSnapshot = "", launchingSnapshot = "";
  const files: { path: string; content: string | Uint8Array; mode?: number }[] = [];
  const session = { sessionId: "session_synthetic", status: "running", vcpus: 1, timeout: 600_000, async stop() { stops++; stopped = true; session.status = "stopped"; if (stopReplyLost) throw new Error("synthetic-secret"); },
    async getCommand() { return { exitCode: commandExited ? 1 : null }; },
    async writeFiles(input: typeof files) { files.push(...input); },
    async readFile() { return Readable.from([JSON.stringify({ node: "v24.22.1" })]); },
    async runCommand(input: { detached?: boolean }) {
      if (input.detached) { launches++; launchingSnapshot = await journal(); if (launchReplyLost) throw new Error("synthetic-secret"); return { cmdId: "cmd_synthetic" }; }
      return { exitCode: 0 };
    },
  };
  const sandbox = { name: relayName(id), persistent: false, image, vcpus: 1, tags: relayTags(id), expiresAt: new Date(Date.now() + 600_000),
    currentSession: () => session, domain: () => "https://synthetic-relay.vercel.run", async delete() { deletes++; present = false; if (deleteReplyLost) throw new Error("synthetic-secret"); },
  };
  const vendor = {
    async get() { return present ? sandbox as unknown as Sandbox : null; },
    async createRelay() { creates++; submittedSnapshot = await journal(); present = true; if (createReplyLost) throw new Error("synthetic-secret"); return sandbox as unknown as Sandbox; },
    async getSession() { return sessionMissing ? null : { id: session.sessionId, status: stopped ? "stopped" as const : "running" as const, projectId: "prj_test", sourceSandboxName: sandbox.name }; },
    async stopSession() { await session.stop(); return null; },
  };
  const call = (operation: "prepare" | "inspect" | "stop", signal = new AbortController().signal, alternate = id) => {
    const initialize = operation === "prepare" && firstDispatch && !signal.aborted;
    if (initialize) firstDispatch = false;
    return relayOperation({ dataDir, identity: alternate, operation, signal, initialize, vendor: async () => vendor });
  };
  async function journal() { return readFile(join(dataDir, "relay-intents", `${relayName(id)}.json`), "utf8"); }
  return { call, id, sandbox, session, files, dataDir, journal,
    removeJournal: () => rm(join(dataDir, "relay-intents", `${relayName(id)}.json`)),
    async resetPhaseToPrepared() {
      const record = JSON.parse(await journal()); record.view.phase = "prepared";
      await writeFile(join(dataDir, "relay-intents", `${relayName(id)}.json`), JSON.stringify(record));
    },
    get stops() { return stops; },
    get creates() { return creates; }, get launches() { return launches; }, get deletes() { return deletes; },
    get submitted() { return submittedSnapshot; }, get launching() { return launchingSnapshot; },
    set createReplyLost(v: boolean) { createReplyLost = v; }, set launchReplyLost(v: boolean) { launchReplyLost = v; },
    set stopReplyLost(v: boolean) { stopReplyLost = v; }, set deleteReplyLost(v: boolean) { deleteReplyLost = v; },
    set sessionMissing(v: boolean) { sessionMissing = v; }, set commandExited(v: boolean) { commandExited = v; },
    set present(v: boolean) { present = v; },
  };
}
describe("relay lifecycle — fake cloud only", () => {
  it("persists intent before create and launch; returns bounded public pins, never private configuration", async () => {
    const t = await setup();
    const view = await t.call("prepare");
    expect(JSON.parse(t.submitted).view.phase).toBe("submitted");
    expect(JSON.parse(t.launching).view.phase).toBe("launching");
    expect(view).toMatchObject({ phase: "ready", commandId: "cmd_synthetic", origin: "https://synthetic-relay.vercel.run" });
    expect(view.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(view)).not.toMatch(/PRIVATE KEY|hostKey|authorizedKey|synthetic-secret/);
    expect(t.files).toHaveLength(4);
    expect(t.files.every(f => f.mode === 0o600)).toBe(true);
    expect(String(t.files.find(f => f.path.endsWith("authorized.pub"))!.content)).toBe(t.id.authorizedKey);
    expect(JSON.stringify(t.files)).not.toMatch(/connectorPrivateKey|Bearer|OAuth/);
    const journalPath = join(t.dataDir, "relay-intents", (await readdir(join(t.dataDir, "relay-intents")))[0]!);
    expect((await stat(journalPath)).mode & 0o077).toBe(0);
    expect(await t.call("prepare")).toMatchObject({ phase: "ready" });
    expect(t.creates).toBe(1); expect(t.launches).toBe(1);
    t.commandExited = true;
    expect(await t.call("inspect")).toMatchObject({ observedStatus: "command-exited" });
  });
  it("recovers a lost create reply by exact name and journal; never repeats allocation", async () => {
    const t = await setup(); t.createReplyLost = true;
    await expect(t.call("prepare")).rejects.toThrow();
    expect((await t.call("inspect")).phase).toBe("submitted");
    expect((await t.call("prepare")).phase).toBe("ready");
    expect(t.creates).toBe(1); expect(t.launches).toBe(1);
  });
  it("retains submitted-but-missing intent across subsequent calls rather than allocating", async () => {
    const t = await setup(); t.createReplyLost = true;
    await expect(t.call("prepare")).rejects.toThrow(); t.present = false;
    await expect(t.call("prepare")).rejects.toThrow(/unresolved/);
    await expect(t.call("stop")).rejects.toThrow(/unresolved/);
    expect(t.creates).toBe(1); expect(JSON.parse(await t.journal()).view.phase).toBe("stopping");
    expect(t.deletes).toBe(0);
  });
  it("lost launch reply never replays a detached command; stop kills the owned session", async () => {
    const t = await setup(); t.launchReplyLost = true;
    await expect(t.call("prepare")).rejects.toThrow();
    await expect(t.call("prepare")).rejects.toThrow(/unresolved/);
    expect(await t.call("inspect")).toMatchObject({ phase: "launching", commandId: null });
    expect(await t.call("stop")).toMatchObject({ phase: "removed", computeEnded: true, metadataDeleted: true });
    expect(t.launches).toBe(1); expect(t.deletes).toBe(1);
    expect(await t.call("stop")).toMatchObject({ phase: "removed" });
    expect(JSON.parse(await t.journal()).hostKey).toBe("");
  });
  it("retains uncertain stop/delete replies and proves session stopped before metadata deletion", async () => {
    const t = await setup(); await t.call("prepare"); t.stopReplyLost = true;
    await expect(t.call("stop")).rejects.toThrow(); expect(t.deletes).toBe(0);
    t.deleteReplyLost = true;
    await expect(t.call("stop")).rejects.toThrow();
    expect(JSON.parse(await t.journal()).view.computeEnded).toBe(true);
    expect(await t.call("stop")).toMatchObject({ phase: "removed", computeEnded: true, metadataDeleted: true });
    expect(t.creates).toBe(1);
  });
  it("missing name/session is never cleanup proof", async () => {
    const t = await setup(); await t.call("prepare"); t.present = false; t.sessionMissing = true;
    await expect(t.call("stop")).rejects.toThrow(/unresolved/);
    expect(t.deletes).toBe(0);
    expect(JSON.parse(await t.journal()).view.computeEnded).toBe(false);
  });
  it("rejects changed account, host, setup, tags, session, image, and compute size", async () => {
    const t = await setup(); await t.call("prepare");
    for (const connection of [{ ...t.id.connection, accountId: "foreign" }, { ...t.id.connection, hostId: "host_foreign" }]) {
      await expect(t.call("stop", undefined, { ...t.id, connection })).rejects.toThrow(/original/);
    }
    await expect(t.call("prepare", undefined, { ...t.id, bridgePort: 5000 })).rejects.toThrow(/original/);
    t.sandbox.tags.bbOwner = randomUUID();
    await expect(t.call("stop")).rejects.toThrow(/ownership/);
    t.sandbox.tags = relayTags(t.id); t.session.sessionId = "foreign-session";
    await expect(t.call("stop")).rejects.toThrow(/ownership/);
    t.session.sessionId = "session_synthetic"; t.sandbox.image = "unverified";
    await expect(t.call("prepare")).rejects.toThrow(/resource limits/);
    t.sandbox.image = image; t.sandbox.vcpus = 2;
    await expect(t.call("prepare")).rejects.toThrow(/resource limits/);
    expect(t.deletes).toBe(0);
    expect(await t.call("stop")).toMatchObject({ phase: "removed" });
  });
  it("inspect and pre-aborted prepare do not allocate; concurrent retries create once", async () => {
    const t = await setup();
    await expect(t.call("inspect")).rejects.toThrow(/unresolved/);
    await expect(t.call("prepare", AbortSignal.abort())).rejects.toThrow();
    expect(t.creates).toBe(0);
    await Promise.all([t.call("prepare"), t.call("prepare")]);
    expect(t.creates).toBe(1); expect(t.launches).toBe(1);
  });
  it("journal loss with matching running compute cannot fabricate prepared-state cleanup proof", async () => {
    const t = await setup(); const original = await t.call("prepare");
    await t.removeJournal();
    await expect(t.call("prepare")).rejects.toThrow(/unresolved/);
    await expect(t.call("stop")).rejects.toThrow(/unresolved/);
    expect(t.session.status).toBe("running"); expect(t.stops).toBe(0); expect(t.deletes).toBe(0);
    expect(t.creates).toBe(1); expect(t.launches).toBe(1);
    await expect(t.journal()).rejects.toThrow();
    expect(original.computeEnded).toBe(false); expect(original.metadataDeleted).toBe(false);
  });
  it("prepared labels with observed or recorded sessions require actual stopped proof and deletion", async () => {
    const t = await setup(); await t.call("prepare"); await t.resetPhaseToPrepared();
    expect(await t.call("stop")).toMatchObject({ phase: "removed", computeEnded: true, metadataDeleted: true, observedStatus: "stopped" });
    expect(t.session.status).toBe("stopped"); expect(t.stops).toBe(1); expect(t.deletes).toBe(1);
  });
  it("missing host journal never reinitializes a retained allocated or submitted intent", async () => {
    for (const lostCreate of [false, true]) {
      const t = await setup(); t.createReplyLost = lostCreate;
      if (lostCreate) await expect(t.call("prepare")).rejects.toThrow(); else await t.call("prepare");
      const original = JSON.parse(await t.journal());
      t.session.status = "stopped"; t.present = false; await t.removeJournal();
      await expect(t.call("prepare")).rejects.toThrow(/unresolved/);
      await expect(t.call("inspect")).rejects.toThrow(/unresolved/);
      expect(t.creates).toBe(1); expect(t.launches).toBe(lostCreate ? 0 : 1);
      await expect(t.journal()).rejects.toThrow();
      expect(t.id.generation).toBe(original.identity.generation);
    }
  });
  it("refuses arbitrary images, unbounded control data and artifact corruption", () => {
    expect(relayIdentitySchema.safeParse({ ...identity(), image: "vercel/sandbox/universal:latest" }).success).toBe(false);
    expect(relayIdentitySchema.safeParse({ ...identity(), command: ["sh"] }).success).toBe(false);
    expect(() => verifyRelayArtifact("corrupted")).toThrow(/integrity/);
    expect(() => verifyRelayArtifact()).not.toThrow();
  });
  it("actual public host harness rejects a newly logged-in wrong account before vendor mutation, with redacted errors", async () => {
    const cli = await cliFixture(); disposals.push(() => cli.dispose());
    const dataDir = await mkdtemp(join(tmpdir(), "relay-host-harness-")); disposals.push(() => rm(dataDir, { recursive: true, force: true }));
    let calls = 0;
    const worker = experimental_createHostEntryHarness(createVercelHostEntry(async () => { calls++; throw new Error("synthetic-secret"); }, cli.run), { experimental_paths: { dataDir, tempDir: dataDir } });
    disposals.push(() => worker.experimental_dispose());
    const result = await worker.experimental_call("relayPrepare", { ...identity(), initialize: true, connection: { ...identity().connection, accountId: "foreign_account" } });
    expect(result.ok).toBe(false); expect(calls).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|PRIVATE KEY|token/);
  });
});
