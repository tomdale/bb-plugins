import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { Sandbox } from "@vercel/sandbox";
import { relayArtifact } from "./relay-artifact.js";
import { relayLaunchArgs } from "./relay-launch.js";
import { relayIdentitySchema, relayViewSchema, resolvedRelayImageSchema, relayAdmissionSnapshotSchema, type RelayIdentity, type RelayView } from "./relay-contract.js";
import { SafeError } from "./configuration.js";
import type { createVercelClient } from "./client.js";

import { hash, relayName, relayTags } from "./relay-identity.js";
const recordSchema = z.object({ identity: relayIdentitySchema, view: relayViewSchema, hostKey: z.string().max(8192) }).strict();
type Record = z.infer<typeof recordSchema>;
type Vendor = Pick<ReturnType<typeof createVercelClient>, "get" | "getSession" | "stopSession"> & {
  createRelay(name: string, tags: { [key: string]: string }, image: string, signal: AbortSignal): Promise<Sandbox>;
};
const locks = new Map<string, Promise<unknown>>();
const unresolved = () => new SafeError("Relay operation is unresolved. Retain its key and original authentication connection; inspect or stop explicitly. No replacement was allocated.");

function hostIdentity() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const sshString = (b: Buffer) => { const n = Buffer.alloc(4); n.writeUInt32BE(b.length); return Buffer.concat([n, b]); };
  const mpint = (v: string) => { const b = Buffer.from(v, "base64url"); return sshString(b[0]! & 128 ? Buffer.concat([Buffer.from([0]), b]) : b); };
  const blob = Buffer.concat([sshString(Buffer.from("ssh-rsa")), mpint(jwk.e!), mpint(jwk.n!)]);
  return { hostKey: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(), fingerprint: hash(blob) };
}
export function verifyRelayArtifact(source: string = relayArtifact.source, expected: string = relayArtifact.sha256) {
  if (Buffer.byteLength(source) > 1024 * 1024 || hash(source) !== expected) throw new SafeError("Pinned relay artifact integrity check failed.");
}
function checkOwned(r: Record, sandbox: Sandbox) {
  if (sandbox.name !== r.view.name || sandbox.persistent ||
    Object.entries(relayTags(r.identity)).some(([k, v]) => sandbox.tags?.[k] !== v) ||
    (r.view.sessionId !== null && sandbox.currentSession().sessionId !== r.view.sessionId))
    throw new SafeError("Relay ownership or session changed; refusing access and cleanup of unrelated compute.");
}
function originOf(sandbox: Sandbox) {
  const url = new URL(sandbox.domain(8080));
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash ||
      !/^[a-z0-9-]+\.vercel\.run$/.test(url.hostname)) throw new SafeError("Unexpected Vercel relay origin; retain intent and stop explicitly.");
  return url.origin;
}

/** One daemon worker is the journal writer. Uncertain mutations are never replayed. */
export async function relayOperation(options: {
  dataDir: string; identity: RelayIdentity; operation: "prepare" | "inspect" | "stop";
  signal: AbortSignal; vendor: () => Promise<Vendor>;
  initialize?: boolean;
}): Promise<RelayView> {
  const { signal } = options;
  const identity = relayIdentitySchema.parse(options.identity);
  const dir = join(options.dataDir, "relay-intents");
  const path = join(dir, `${relayName(identity)}.json`);
  const previous = locks.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    signal.throwIfAborted();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    async function save(record: Record, exclusive = false) {
      const text = JSON.stringify(recordSchema.parse(record));
      if (Buffer.byteLength(text) > 32768) throw unresolved();
      const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
      const file = await open(target, "wx", 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      if (!exclusive) await rename(target, path);
      const directory = await open(dir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    let record: Record;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 32768 || (info.mode & 0o077)) throw unresolved();
      record = recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw unresolved();
      if (options.operation !== "prepare" || options.initialize !== true) throw unresolved();
      const keys = hostIdentity();
      record = { identity, hostKey: keys.hostKey, view: {
        key: identity.key, generation: identity.generation, name: relayName(identity),
        hostId: identity.connection.hostId, accountId: identity.connection.accountId,
        teamId: identity.connection.teamId, projectId: identity.connection.projectId,
        phase: "prepared", sessionId: null, commandId: null, origin: null, fingerprint: keys.fingerprint,
        expiresAt: null, computeEnded: false, metadataDeleted: false, observedStatus: "unobserved", artifactSha256: relayArtifact.sha256,
        requestedImage: identity.image, image: null, resolvedImage: null, nodeVersion: null, vcpus: null, persistent: null, timeoutMs: null,
        commandObservation: { state: "not-submitted", exitCode: null, reason: "none" }, adapterObservation: { state: "unobserved", snapshot: null },
      } };
      await save(record, true);
    }
    if (JSON.stringify(record.identity) !== JSON.stringify(identity)) throw new SafeError("Relay intent does not match its original authentication connection or setup.");
    if (options.operation === "prepare" && record.view.artifactSha256 !== relayArtifact.sha256) throw new SafeError("Relay artifact changed; inspect or stop the original intent before new setup.");
    const r = record;
    const transition = async (phase: RelayView["phase"]) => { r.view.phase = phase; await save(r); signal.throwIfAborted(); };
    if (r.view.phase === "removed") return r.view;
    const vendor = await options.vendor();
    let sandbox = await vendor.get(r.view.name, signal);
    let originChanged = false;
    let imageChanged = false;
    const observe = (sandbox: Sandbox) => {
      r.view.sessionId = sandbox.currentSession().sessionId;
      r.view.expiresAt = sandbox.expiresAt?.getTime() ?? null;
      r.view.observedStatus = sandbox.currentSession().status;
      r.view.image = sandbox.image ?? null;
      r.view.vcpus = sandbox.currentSession().vcpus;
      r.view.persistent = sandbox.persistent;
      r.view.timeoutMs = sandbox.currentSession().timeout;
      const image = resolvedRelayImageSchema.safeParse(sandbox.image);
      imageChanged = !image.success || (r.view.resolvedImage !== null && r.view.resolvedImage !== image.data);
      if (image.success && r.view.resolvedImage === null) r.view.resolvedImage = image.data;
    };
    if (sandbox) {
      checkOwned(r, sandbox);
      observe(sandbox);
      if (r.view.origin && options.operation !== "stop") {
        originChanged = originOf(sandbox) !== r.view.origin;
        if (originChanged && options.operation === "prepare") throw new SafeError("Relay origin changed; explicit stop and new setup are required.");
      }
      await save(r);
      if (imageChanged && options.operation !== "stop") throw new SafeError("Relay resolved image is unsupported or changed. Retain the original identity and stop explicitly.");
    }
    if (options.operation === "inspect") {
      r.view.observedStatus = sandbox?.currentSession().status ?? "missing";
      if (sandbox && r.view.commandId && sandbox.currentSession().status === "running") {
        try {
          const command = await sandbox.currentSession().getCommand(r.view.commandId, { signal });
          const code = command.exitCode;
          if (code === null) r.view.commandObservation = { state: "pending-or-running", exitCode: null, reason: "none" };
          else if (Number.isInteger(code) && code >= -255 && code <= 255) r.view.commandObservation = { state: "exited", exitCode: code, reason: "none" };
          else r.view.commandObservation = { state: "unavailable", exitCode: null, reason: "invalid-exit-code" };
          r.view.observedStatus = code === null ? "command-pending-or-running" : r.view.commandObservation.state === "exited" ? "command-exited" : "command-observation-unavailable";
        } catch {
          signal.throwIfAborted();
          r.view.commandObservation = { state: "unavailable", exitCode: null, reason: "observation-failed" };
          r.view.observedStatus = "command-observation-unavailable";
        }
        let diagnostics: Readable | null = null;
        try {
          diagnostics = await sandbox.currentSession().readFile({ path: `/tmp/bb-relay-${identity.generation}/host.pem.diagnostics.json` }, { signal }) as Readable | null;
          if (!diagnostics) r.view.adapterObservation = { state: "missing", snapshot: null };
          else {
            let text = "";
            for await (const chunk of diagnostics) {
              text += Buffer.from(chunk).toString("utf8");
              if (Buffer.byteLength(text) > 4096) throw new Error("Diagnostic snapshot limit");
            }
            r.view.adapterObservation = { state: "available", snapshot: relayAdmissionSnapshotSchema.parse(JSON.parse(text)) };
          }
        } catch {
          signal.throwIfAborted();
          r.view.adapterObservation = { state: diagnostics ? "invalid" : "unavailable", snapshot: null };
        } finally { diagnostics?.destroy(); }
      }
      if (!sandbox && r.view.sessionId && !r.view.computeEnded) {
        const session = await vendor.getSession({ sessionId: r.view.sessionId, projectId: identity.connection.projectId, sandboxName: r.view.name }, signal);
        r.view.observedStatus = session?.status ?? "missing";
        r.view.computeEnded = session?.status === "stopped";
      }
      if (originChanged) r.view.observedStatus = "origin-changed";
      await save(r); return r.view;
    }
    if (options.operation === "stop") {
      if (r.view.phase === "prepared" && !sandbox && r.view.sessionId === null) { r.view.computeEnded = true; r.view.metadataDeleted = true; r.view.observedStatus = "never-submitted"; r.hostKey = ""; await transition("removed"); return r.view; }
      if (!r.view.computeEnded) {
        await transition("stopping");
        if (!r.view.sessionId) throw unresolved();
        const resource = { sessionId: r.view.sessionId, projectId: identity.connection.projectId, sandboxName: r.view.name };
        let session = await vendor.getSession(resource, signal);
        if (session?.status === "running" || session?.status === "pending") {
          if (sandbox) await sandbox.currentSession().stop({ signal });
          else await vendor.stopSession(resource, signal);
          session = await vendor.getSession(resource, signal);
        }
        if (session?.status !== "stopped") throw unresolved();
        r.view.computeEnded = true; r.view.observedStatus = "stopped"; await save(r);
      }
      await transition("deleting");
      if (sandbox) await sandbox.delete({ deleteOrphanSnapshots: true, signal });
      const remaining = await vendor.get(r.view.name, signal);
      if (remaining) { checkOwned(r, remaining); throw unresolved(); }
      r.view.metadataDeleted = true; r.hostKey = "";
      await transition("removed"); return r.view;
    }
    if (!sandbox) {
      if (r.view.phase !== "prepared") throw unresolved();
      verifyRelayArtifact();
      await transition("submitted");
      sandbox = await vendor.createRelay(r.view.name, relayTags(identity), identity.image, signal);
      checkOwned(r, sandbox);
      observe(sandbox);
      await transition("allocated");
    }
    if (r.view.phase === "submitted") await transition("allocated");
    if (imageChanged || r.view.resolvedImage === null || sandbox.vcpus !== 1 || sandbox.currentSession().vcpus !== 1 || sandbox.currentSession().timeout !== 600_000)
      throw new SafeError("Relay runtime or resource limits differ from setup. Inspect and stop the original allocation explicitly.");
    if (r.view.phase === "ready") {
      if (r.view.nodeVersion === null) throw unresolved();
      return r.view;
    }
    if (r.view.phase !== "allocated" || sandbox.currentSession().status !== "running") throw unresolved();
    verifyRelayArtifact();
    r.view.origin = originOf(sandbox);
    await save(r);
    const session = sandbox.currentSession();
    const root = `/tmp/bb-relay-${identity.generation}`;
    // Only fixed commands and generated paths are admitted. No vendor logs are read.
    const init = await session.runCommand({ cmd: "node", args: ["-e", 'const f=require("node:fs"),p=process.argv[1];f.mkdirSync(p,{recursive:true,mode:448});f.chmodSync(p,448);f.writeFileSync(p+"/runtime.json",JSON.stringify({node:process.version}),{mode:384})', root], timeoutMs: 10_000, signal });
    if (init.exitCode !== 0) throw unresolved();
    const runtime = await session.readFile({ path: `${root}/runtime.json` }, { signal }) as Readable | null;
    if (!runtime) throw unresolved();
    let text = "";
    try {
      for await (const chunk of runtime) {
        text += Buffer.from(chunk).toString("utf8");
        if (Buffer.byteLength(text) > 128) throw unresolved();
      }
    } finally { runtime.destroy(); }
    r.view.nodeVersion = z.object({ node: relayViewSchema.shape.nodeVersion.unwrap() }).strict().parse(JSON.parse(text)).node;
    await save(r);
    await session.writeFiles([
      { path: `${root}/relay.mjs`, content: relayArtifact.source, mode: 0o600 },
      { path: `${root}/host.pem`, content: r.hostKey, mode: 0o600 },
      { path: `${root}/authorized.pub`, content: identity.authorizedKey, mode: 0o600 },
      { path: `${root}/config.json`, content: JSON.stringify({ publicAuthority: new URL(r.view.origin).host, port: 8080, reversePort: 38992, bridgePort: identity.bridgePort, hostKeyFile: `${root}/host.pem`, authorizedKeyFile: `${root}/authorized.pub` }), mode: 0o600 },
    ], { signal });
    r.view.commandObservation = { state: "submission-uncertain", exitCode: null, reason: "none" };
    await transition("launching");
    const command = await session.runCommand({ cmd: "node", args: relayLaunchArgs(root), detached: true, timeoutMs: 600_000, signal });
    r.view.commandId = command.cmdId;
    r.view.observedStatus = "command-submitted";
    r.view.commandObservation = { state: "submitted", exitCode: null, reason: "none" };
    await transition("ready");
    return r.view;
  });
  locks.set(path, pending);
  try { return await pending; } finally { if (locks.get(path) === pending) locks.delete(path); }
}
