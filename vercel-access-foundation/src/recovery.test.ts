import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Authority, FilePersistence, MemoryPersistence, type Boundary, type Lease } from "./transport/authority.ts";
import { LocalFence, FileFenceStorage } from "./transport/relay.ts";
import { fresh } from "./transport/protocol.ts";

const crash = () => { throw new Error("Synthetic interruption"); };
for (const boundary of ["intent", "issued", "active"] as Boundary[]) {
  test(`persisted acquisition restart at ${boundary}; stable same-epoch credential`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "vercel-access-fixture-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const persistence = new FilePersistence(join(directory, "grants.json"));
    const issued: Lease[] = [];
    const adapter = { async issue(lease: Lease) {
      const persisted = await persistence.load();
      assert.equal(persisted.leases.find((x) => x.id === lease.id)!.phase, "pending");
      issued.push(lease);
    }, async revoke() {} };
    const interrupted = new Authority(persistence, () => 1000, adapter, (name) => { if (name === boundary) crash(); });
    await interrupted.recover();
    await assert.rejects(interrupted.acquire("key", "host"), /interruption/);
    const saved = (await persistence.load()).leases[0]!;
    assert.equal(interrupted.byId(saved.id), undefined);
    const recovered = new Authority(persistence, () => 1000, adapter);
    await Promise.all([recovered.recover(), recovered.recover()]);
    const a = await recovered.acquire("key", "host"), b = await recovered.acquire("key", "host");
    assert.equal(a.id, saved.id); assert.equal(a.token, saved.token); assert.deepEqual(a, b); assert.equal(a.epoch, 1);
    assert(issued.every((x) => x.id === saved.id && x.token === saved.token));
    assert.equal((await stat(persistence.path)).mode & 0o777, 0o600);
  });
}
for (const boundary of ["revoke-intent", "remote-revoked", "revoked"] as Boundary[]) {
  test(`persisted release restart at ${boundary}; tombstones and epoch-aware same-key repair`, async () => {
    const persistence = new MemoryPersistence(), revoked: string[] = [];
    const first = new Authority(persistence, () => 1000); await first.recover();
    const old = await first.acquire("key", "host");
    const adapter = { async issue() {}, async revoke(lease: Lease) { revoked.push(lease.id); } };
    const interrupted = new Authority(persistence, () => 1000, adapter, (name) => { if (name === boundary) crash(); });
    await interrupted.recover();
    await assert.rejects(interrupted.release("key", "host", old.epoch, null));
    assert.equal(interrupted.byId(old.id), undefined);
    const recovered = new Authority(persistence, () => 1000, adapter); await recovered.recover();
    assert.equal(recovered.byId(old.id), undefined);
    const next = await recovered.acquire("key", "host");
    assert.equal(next.epoch, 2); assert.notEqual(next.id, old.id); assert.notEqual(next.token, old.token);
    await recovered.release("key", "host", old.epoch, null);
    assert.equal(recovered.byId(next.id)!.id, next.id); // A delayed null-ID release cannot cross epochs.
    await assert.rejects(recovered.release("key", "host", next.epoch, old.id));
    assert.equal((await persistence.load()).leases[0]!.phase, "revoked");
    assert(revoked.every((id) => id === old.id));
  });
}
test("serialized acquisition/release barriers and fail-closed remote revoke outage", async () => {
  const persistence = new MemoryPersistence();
  let issued!: () => void, proceed!: () => void;
  const issueReached = new Promise<void>((resolve) => { issued = resolve; });
  const resumeIssue = new Promise<void>((resolve) => { proceed = resolve; });
  const authority = new Authority(persistence, () => 1000, {
    async issue() { issued(); await resumeIssue; }, async revoke() { throw new Error("Synthetic remote outage"); },
  });
  await authority.recover();
  const acquiring = authority.acquire("key", "host");
  await issueReached;
  const pending = (await persistence.load()).leases[0]!;
  assert.equal(pending.phase, "pending"); assert.equal(authority.byId(pending.id), undefined);
  let releaseFinished = false;
  const releasing = authority.release("key", "host", 1, null).finally(() => { releaseFinished = true; });
  assert.equal(releaseFinished, false);
  proceed(); await acquiring; await assert.rejects(releasing, /outage/);
  assert.equal((await persistence.load()).leases[0]!.phase, "revoking");
  assert.equal(authority.byId(pending.id), undefined);
  await assert.rejects(authority.acquire("key", "host"));
  const restarted = new Authority(persistence, () => 1000); await restarted.recover();
  assert.equal((await restarted.acquire("key", "host")).epoch, 2);
});
test("expired pending credentials are revoked on restart, and corrupt journals fail closed", async () => {
  const persistence = new MemoryPersistence();
  const authority = new Authority(persistence, () => 1000, undefined, (name) => { if (name === "intent") crash(); });
  await authority.recover(); await assert.rejects(authority.acquire("key", "host", 1));
  const restarted = new Authority(persistence, () => 1002); await restarted.recover();
  assert.equal((await persistence.load()).leases[0]!.phase, "revoked");
  const bad = new MemoryPersistence(); bad.state = { version: 1, leases: [null as unknown as Lease] };
  await assert.rejects(new Authority(bad).recover());
});

test("file-backed relay generation and connector epoch fencing survive controller restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vercel-access-fence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new FileFenceStorage(join(directory, "fence.json"));
  const fence = new LocalFence(storage), boot = fresh(), connectorEpoch = fresh();
  await fence.claim(1, boot); await fence.claim(1, boot, connectorEpoch);
  assert.equal((await storage.load())!.connectorEpoch, connectorEpoch);
  const restarted = new LocalFence(new FileFenceStorage(storage.path)), nextBoot = fresh();
  await restarted.claim(2, nextBoot);
  await assert.rejects(fence.claim(1, boot, fresh()));
  assert.equal((await storage.load())!.boot, nextBoot);
  assert.equal((await stat(storage.path)).mode & 0o777, 0o600);
});
test("failed journal save denies issuance and journal bounds fail closed", async () => {
  const persistence = new MemoryPersistence();
  let issued = false;
  const authority = new Authority({ load: () => persistence.load(), async save() { throw new Error("Synthetic disk full"); } }, () => 1000,
    { async issue() { issued = true; }, async revoke() {} });
  await authority.recover(); await assert.rejects(authority.acquire("key", "host"));
  assert.equal(issued, false); assert.equal(persistence.state.leases.length, 0);
  const full = new MemoryPersistence();
  full.state.leases = Array.from({ length: 512 }, (_, i) => ({ key: `key-${i}`, hostId: "host", id: `id-${i}`, epoch: 1,
    token: `token-${i}`, phase: "revoked" as const, expiresAt: 2000 }));
  const bounded = new Authority(full, () => 1000); await bounded.recover();
  await assert.rejects(bounded.acquire("new", "host"), /budget/);
  assert.equal(full.state.leases.length, 512);
});
