import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { createInput, runSchema, type Run } from "./contracts.ts";

const OUTPUT_LIMIT = 16000;
export class Subagents {
  private db;
  private locks = new Map<string, Promise<unknown>>();
  private disposed = false;
  constructor(private bb: BbPluginApi, private settings: () => Promise<{ maxDepth: number; maxConcurrent: number; defaultTimeout: number }>) {
    this.db = bb.storage.database();
    bb.storage.migrate(this.db, [
      "CREATE TABLE runs (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE INDEX runs_thread ON runs(json_extract(data, '$.threadId'))",
      "CREATE INDEX runs_root ON runs(json_extract(data, '$.rootThreadId'))",
      "CREATE INDEX runs_owner ON runs(json_extract(data, '$.ownerThreadId'))",
    ]);
  }
  private query(where: string, args: string[] = [], limit?: number): Run[] {
    return (this.db.prepare(`SELECT data FROM runs WHERE ${where} ORDER BY rowid DESC${limit ? ` LIMIT ${limit}` : ""}`).all(...args) as { data: string }[]).map(row => runSchema.parse(JSON.parse(row.data)));
  }
  get(id: string): Run {
    const row = this.db.prepare("SELECT data FROM runs WHERE id = ?").get(id) as { data: string } | undefined;
    if (!row) throw new Error("Subagent run not found.");
    return runSchema.parse(JSON.parse(row.data));
  }
  byThread(threadId: string) { return this.query("json_extract(data, '$.threadId') = ?", [threadId], 1)[0]; }
  list(threadId: string) {
    return { runs: this.query("json_extract(data, '$.rootThreadId') = ? OR json_extract(data, '$.ownerThreadId') = ?", [threadId, threadId], 100), promoted: this.byThread(threadId) ?? null };
  }
  private save(run: Run) {
    this.db.prepare("INSERT INTO runs (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(run.id, JSON.stringify(run));
    this.bb.realtime.publish("changed", { threadId: run.rootThreadId });
  }
  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.locks.set(id, next);
    try { return await next; }
    finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  private owns(caller: string, run: Run): boolean {
    let owner = run.ownerThreadId;
    const visited = new Set<string>();
    while (!visited.has(owner)) {
      if (owner === caller) return true;
      visited.add(owner);
      const parent = this.byThread(owner);
      if (!parent) break;
      owner = parent.ownerThreadId;
    }
    return false;
  }
  status(caller: string, id?: string) {
    const root = this.byThread(caller)?.rootThreadId ?? caller;
    const runs = id ? [this.get(id)] : this.query("json_extract(data, '$.rootThreadId') = ?", [root]).filter(run => this.owns(caller, run)).slice(0, 100);
    if (runs.some(run => !this.owns(caller, run))) throw new Error("This subagent belongs to another thread.");
    return id ? runs : runs.map(({ id, title, status, control, threadId, depth, createdAt, error }) => ({ id, title, status, control, threadId, depth, createdAt, error }));
  }
  async create(ownerThreadId: string, input: z.infer<typeof createInput>) {
    const owner = await this.bb.sdk.threads.get({ threadId: ownerThreadId });
    if (!owner.environmentId || owner.archivedAt || owner.deletedAt) throw new Error("Subagents need an active thread with an existing environment.");
    const parent = this.byThread(ownerThreadId);
    const depth = (parent?.depth ?? 0) + 1;
    const settings = await this.settings();
    if (depth > settings.maxDepth) throw new Error(`Maximum subagent depth (${settings.maxDepth}) reached.`);
    const defaults = await this.bb.sdk.threads.defaultExecutionOptions({ threadId: ownerThreadId });
    if (!defaults) throw new Error("The original thread has no resolved execution settings yet.");
    const rootThreadId = parent?.rootThreadId ?? ownerThreadId;
    const active = this.db.prepare("SELECT count(*) AS count FROM runs WHERE json_extract(data, '$.rootThreadId') = ? AND json_extract(data, '$.control') = 'agent' AND json_extract(data, '$.status') IN ('starting', 'running')").get(rootThreadId) as { count: number };
    if (active.count >= settings.maxConcurrent) throw new Error("Maximum concurrent subagents reached.");
    const timeout = input.timeout ?? settings.defaultTimeout;
    const run: Run = {
      id: randomUUID(), ownerThreadId, rootThreadId, threadId: null,
      title: input.title ?? input.task.slice(0, 80), task: input.task, depth,
      createdAt: Date.now(), deadline: timeout === 0 ? null : Date.now() + timeout * 1000,
      status: "starting", control: "agent", output: "", error: null, notifications: [], cleanupPending: false,
    };
    // Reserve capacity before awaiting spawn; concurrent create calls see the reservation.
    this.save(run);
    return this.serial(run.id, async () => {
      try {
        const child = await this.bb.sdk.threads.spawn({
          projectId: owner.projectId, environment: { type: "reuse", environmentId: owner.environmentId! },
          lifecycleOwnerThreadId: rootThreadId, visibility: "hidden", prompt: input.task, title: run.title,
          pluginMetadata: { runId: run.id },
          providerId: owner.providerId, model: input.model ?? defaults.model,
          reasoningLevel: defaults.reasoningLevel, permissionMode: defaults.permissionMode, serviceTier: defaults.serviceTier,
        });
        run.threadId = child.id;
        run.status = "running";
        this.save(run);
        await this.reconcileOne(run).catch(cause => this.bb.log.warn(`Subagent reconciliation: ${String(cause)}`));
        return this.get(run.id);
      } catch (cause) {
        run.status = "failed";
        run.error = String(cause);
        this.save(run);
        if (run.threadId) { run.cleanupPending = true; this.save(run); await this.cleanup(run); }
        throw cause;
      }
    });
  }
  private async cleanup(run: Run) {
    if (!run.threadId) return;
    try { await this.bb.sdk.threads.archive({ threadId: run.threadId }); }
    finally { await this.bb.sdk.threads.stop({ threadId: run.threadId }); }
    run.cleanupPending = false;
    this.save(run);
  }
  private queue(run: Run, text: string) { run.notifications.push(text); this.save(run); }
  private async notify(run: Run) {
    while (run.notifications.length) {
      const owner = await this.bb.sdk.threads.get({ threadId: run.ownerThreadId });
      if (owner.deletedAt || owner.archivedAt) return;
      await this.bb.sdk.threads.send({ threadId: run.ownerThreadId, mode: "auto", input: [{ type: "text", text: run.notifications[0]!, mentions: [] }] });
      run.notifications.shift();
      this.save(run);
    }
  }
  private async output(run: Run) {
    if (!run.threadId) return;
    const result = await this.bb.sdk.threads.output({ threadId: run.threadId });
    run.output = (result.output ?? "").slice(0, OUTPUT_LIMIT);
  }
  private async finish(run: Run, status: Run["status"], error: string | null = null) {
    run.status = status; run.error = error; run.cleanupPending = true;
    this.save(run);
    try {
      if (status !== "completed" && run.threadId) await this.bb.sdk.threads.stop({ threadId: run.threadId });
      await this.output(run);
    }
    finally {
      this.queue(run, `Subagent ${JSON.stringify(run.title)} (${run.id}) ${status}. ${error ?? ""}\n${run.output}\nFull transcript: @thread:${run.threadId}`);
      await this.cleanup(run);
    }
    await this.notify(run);
  }
  async settle(threadId: string, failed?: string) {
    const candidate = this.byThread(threadId);
    if (!candidate) return;
    await this.serial(candidate.id, async () => {
      const run = this.get(candidate.id);
      if (run.control !== "agent" || !["starting", "running"].includes(run.status)) return;
      await this.finish(run, failed ? "failed" : "completed", failed ?? null);
    });
  }
  async kill(caller: string, id: string, reason: string) {
    return this.serial(id, async () => {
      const run = this.get(id);
      if (!this.owns(caller, run)) throw new Error("This subagent belongs to another thread.");
      if (run.control !== "agent") throw new Error("The user controls this session; it cannot be killed by an agent.");
      if (["starting", "running"].includes(run.status)) await this.finish(run, "killed", reason);
      return this.get(id);
    });
  }
  async promote(id: string) {
    return this.serial(id, async () => {
      const run = this.get(id);
      if (!run.threadId) throw new Error("Subagent is still starting.");
      if (run.control === "user") { await this.notify(run); return { threadId: run.threadId }; }
      await this.bb.sdk.threads.unarchive({ threadId: run.threadId });
      await this.bb.sdk.threads.update({ threadId: run.threadId, visibility: "visible" });
      run.control = "user"; run.deadline = null; run.cleanupPending = false;
      this.queue(run, `The user has taken control of subagent ${JSON.stringify(run.title)} (${run.id}) and begun interacting in @thread:${run.threadId}. Treat its work as user-controlled until they return control.`);
      await this.notify(run);
      return { threadId: run.threadId };
    });
  }
  async returnControl(id: string) {
    return this.serial(id, async () => {
      const run = this.get(id);
      if (!run.threadId) throw new Error("Subagent is still starting.");
      if (run.control !== "user") { await this.notify(run); return { threadId: run.ownerThreadId }; }
      // Stop before reading output so the handoff describes a quiescent session.
      await this.bb.sdk.threads.stop({ threadId: run.threadId });
      await this.output(run);
      await this.bb.sdk.threads.update({ threadId: run.threadId, visibility: "hidden" });
      await this.bb.sdk.threads.archive({ threadId: run.threadId });
      run.control = "returned"; run.status = "completed";
      this.queue(run, `The user returned control of subagent ${JSON.stringify(run.title)} (${run.id}).\n${run.output}\nFull transcript: @thread:${run.threadId}`);
      await this.notify(run);
      return { threadId: run.ownerThreadId };
    });
  }
  private async reconcileOne(run: Run) {
    if (!run.threadId) {
      if (run.status !== "starting") return;
      // A server crash can happen after spawn commits but before the returned ID is saved.
      let offset = 0;
      while (!run.threadId) {
        const page = await this.bb.sdk.threads.list({ originPluginId: this.bb.pluginId, includeHidden: true, archived: false, limit: 100, offset });
        for (const candidate of page) {
          const metadata = await this.bb.sdk.threads.getPluginMetadata({ threadId: candidate.id });
          if (metadata.runId === run.id) { run.threadId = candidate.id; run.status = "running"; this.save(run); break; }
        }
        if (page.length < 100) break;
        offset += 100;
      }
      if (!run.threadId) {
        run.status = "failed"; run.error = "Interrupted before the worker thread was attached.";
        this.queue(run, `Subagent ${JSON.stringify(run.title)} (${run.id}) failed before its worker attached.`);
        await this.notify(run); return;
      }
    }
    if (run.control !== "agent") { await this.notify(run); return; }
    if (!["starting", "running"].includes(run.status)) {
      if (run.cleanupPending) await this.cleanup(run);
      await this.notify(run); return;
    }
    const child = await this.bb.sdk.threads.get({ threadId: run.threadId });
    if (child.deletedAt) {
      run.status = "failed"; run.error = "Worker thread deleted.";
      this.queue(run, `Subagent ${JSON.stringify(run.title)} (${run.id}) failed: worker thread deleted.`);
      await this.notify(run); return;
    }
    if (child.archivedAt) { await this.finish(run, "killed", "Worker archived before completion."); return; }
    if (run.deadline !== null && Date.now() >= run.deadline) await this.finish(run, "timed-out", "Subagent timeout exceeded.");
    else if (child.status === "idle") await this.finish(run, "completed");
    else if (child.status === "error") await this.finish(run, "failed", "Worker failed; inspect its transcript.");
  }
  async reconcile() {
    for (const run of this.query("(json_extract(data, '$.control') = 'agent' AND (json_extract(data, '$.status') IN ('starting', 'running') OR json_extract(data, '$.cleanupPending') = 1)) OR json_array_length(data, '$.notifications') > 0")) {
      if (this.disposed) return;
      // Revisit only active runs or pending deliveries; settled runtime cleanup is retried on reload.
      if ((run.control === "agent" && (["starting", "running"].includes(run.status) || run.cleanupPending)) || run.notifications.length) {
        await this.serial(run.id, () => this.reconcileOne(this.get(run.id))).catch(cause => this.bb.log.warn(`Subagent ${run.id}: ${String(cause)}`));
      }
    }
  }
  async dispose() { this.disposed = true; await Promise.allSettled(this.locks.values()); }
}
