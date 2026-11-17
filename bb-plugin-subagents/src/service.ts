import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { createInput, runSchema, type resumeInput, type Run } from "./contracts.ts";
import { extractOneSentenceSummary } from "./status.ts";
import { declaresComplete, graceMsFor, noticeMessage, resumeMessage, scheduleTimeout, windDownMessage } from "./timeout.ts";
import {
  defaultSummarizer,
  SUMMARY_EXCERPT_LIMIT,
  SUMMARY_INTERVAL_MS,
  type StatusSummarizer,
} from "./summarizer.ts";

const OUTPUT_LIMIT = 16000;
const WORKING = ["starting", "running", "winding-down"];
const WORKING_SQL = WORKING.map(status => `'${status}'`).join(", ");
const WOUND_DOWN = "Time limit reached; the worker wrapped up when asked but reported the task incomplete.";
const isWorking = (run: Run) => WORKING.includes(run.status);

export class Subagents {
  private db;
  private locks = new Map<string, Promise<unknown>>();
  private disposed = false;

  constructor(
    private bb: BbPluginApi,
    private settings: () => Promise<{ maxDepth: number; maxConcurrent: number; defaultTimeout: number }>,
    private summarizer: StatusSummarizer = defaultSummarizer,
  ) {
    this.db = bb.storage.database();
    bb.storage.migrate(this.db, [
      "CREATE TABLE runs (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE INDEX runs_thread ON runs(json_extract(data, '$.threadId'))",
      "CREATE INDEX runs_root ON runs(json_extract(data, '$.rootThreadId'))",
      "CREATE INDEX runs_owner ON runs(json_extract(data, '$.ownerThreadId'))",
    ]);
  }

  private query(where: string, args: string[] = [], limit?: number): Run[] {
    return (
      this.db
        .prepare(`SELECT data FROM runs WHERE ${where} ORDER BY rowid DESC${limit ? ` LIMIT ${limit}` : ""}`)
        .all(...args) as { data: string }[]
    ).map(row => runSchema.parse(JSON.parse(row.data)));
  }

  get(id: string): Run {
    const row = this.db.prepare("SELECT data FROM runs WHERE id = ?").get(id) as { data: string } | undefined;
    if (!row) throw new Error("Subagent run not found.");
    return runSchema.parse(JSON.parse(row.data));
  }

  byThread(threadId: string) {
    return this.query("json_extract(data, '$.threadId') = ?", [threadId], 1)[0];
  }

  async list(threadId: string) {
    const rawRuns = this.query(
      "(json_extract(data, '$.rootThreadId') = ? OR json_extract(data, '$.ownerThreadId') = ?) AND json_extract(data, '$.control') = 'agent'",
      [threadId, threadId],
      100,
    );
    const runs = await Promise.all(rawRuns.map(run => this.hydrateExecution(run)));
    return { runs };
  }

  private async hydrateExecution(run: Run): Promise<Run> {
    const updatedSummary = run.statusSummary
      ? run.statusSummary
      : extractOneSentenceSummary(run.output || run.error || run.task, run.title);
    if (run.providerId && run.model && run.reasoningLevel) {
      return updatedSummary === run.statusSummary ? run : { ...run, statusSummary: updatedSummary };
    }
    const candidates = [run.threadId, run.ownerThreadId, run.rootThreadId].filter(
      (id, index, all): id is string => Boolean(id) && all.indexOf(id) === index,
    );
    let providerId = run.providerId;
    let model = run.model;
    let reasoningLevel = run.reasoningLevel;
    for (const candidateId of candidates) {
      if (!providerId) {
        try {
          const thread = await this.bb.sdk.threads.get({ threadId: candidateId });
          if (thread?.providerId) providerId = thread.providerId;
        } catch {
          // Try next candidate thread.
        }
      }
      if (!model || !reasoningLevel) {
        try {
          const defaults = await this.bb.sdk.threads.defaultExecutionOptions({ threadId: candidateId });
          if (defaults) {
            if (!model && defaults.model) model = defaults.model;
            if (!reasoningLevel && defaults.reasoningLevel) reasoningLevel = defaults.reasoningLevel;
          }
        } catch {
          // Try next candidate thread.
        }
      }
      if (providerId && model && reasoningLevel) break;
    }
    const hydrated: Run = {
      ...run,
      providerId,
      model,
      reasoningLevel,
      statusSummary: updatedSummary,
    };
    if (
      hydrated.providerId !== run.providerId ||
      hydrated.model !== run.model ||
      hydrated.reasoningLevel !== run.reasoningLevel ||
      hydrated.statusSummary !== run.statusSummary
    ) {
      this.save(hydrated);
    }
    return hydrated;
  }

  /** Per root thread: active background subagent counts, for sidebar row glyphs. */
  activeRoots() {
    const roots = new Map<string, { threadId: string; working: number }>();
    for (const run of this.query(
      `json_extract(data, '$.control') = 'agent' AND json_extract(data, '$.status') IN (${WORKING_SQL})`,
    )) {
      const entry = roots.get(run.rootThreadId) ?? { threadId: run.rootThreadId, working: 0 };
      entry.working++;
      roots.set(run.rootThreadId, entry);
    }
    return [...roots.values()];
  }

  private save(run: Run) {
    this.db
      .prepare("INSERT INTO runs (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(run.id, JSON.stringify(run));
    this.bb.realtime.publish("changed", { threadId: run.rootThreadId });
  }

  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
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

  private async summarize(run: Run, excerptSource = run.output): Promise<string> {
    return this.summarizer({
      title: run.title,
      task: run.task,
      status: run.status,
      error: run.error,
      excerpt: excerptSource.slice(-SUMMARY_EXCERPT_LIMIT),
    });
  }

  status(caller: string, id?: string) {
    const root = this.byThread(caller)?.rootThreadId ?? caller;
    const runs = id
      ? [this.get(id)]
      : this.query("json_extract(data, '$.rootThreadId') = ?", [root])
          .filter(run => this.owns(caller, run))
          .slice(0, 100);
    if (runs.some(run => !this.owns(caller, run))) throw new Error("This subagent belongs to another thread.");
    return id
      ? runs
      : runs.map(({ id, title, status, control, threadId, depth, createdAt, error, statusSummary }) => ({
          id,
          title,
          status,
          control,
          threadId,
          depth,
          createdAt,
          error,
          statusSummary,
        }));
  }

  /**
   * Chooses the worker's reasoning level. A requested level must appear in the
   * selected model's catalog entry; an inherited level that the selected model
   * does not support falls back to that model's default. When the catalog cannot
   * confirm either way, the level passes through and spawn validates it.
   */
  private async resolveReasoningLevel(
    owner: { environmentId: string | null; providerId: string },
    model: string | undefined,
    input: z.infer<typeof createInput>,
    inherited: string | undefined,
  ): Promise<string | undefined> {
    const requested = input.reasoningLevel;
    if (!model || !owner.environmentId || (!requested && !input.model)) return requested ?? inherited;
    let entry;
    try {
      const catalog = await this.bb.sdk.providers.models({
        environmentId: owner.environmentId,
        providerId: owner.providerId,
      });
      if (catalog.modelLoadError === null) {
        entry = [...catalog.models, ...catalog.selectedOnlyModels].find(
          candidate => candidate.id === model || candidate.model === model,
        );
      }
    } catch (cause) {
      this.bb.log.warn(`Subagent model catalog: ${String(cause)}`);
    }
    if (!entry) return requested ?? inherited;
    const supported = entry.supportedReasoningEfforts.map(effort => effort.reasoningEffort);
    if (!requested) {
      return !inherited || supported.length === 0 || supported.includes(inherited)
        ? inherited
        : entry.defaultReasoningEffort;
    }
    if (supported.includes(requested)) return requested;
    const unverifiable = entry.reasoningDiscovery === "unknown" || requested === entry.defaultReasoningEffort;
    if (supported.length === 0 && unverifiable) return requested;
    throw new Error(
      `Reasoning level "${requested}" is not supported by ${owner.providerId}/${model}. Supported reasoning levels: ${
        supported.length > 0 ? supported.join(", ") : entry.defaultReasoningEffort
      }.`,
    );
  }

  /** Deadline fields for a budget of `timeoutSeconds` starting at `startedAt`; 0 means unlimited. */
  private budget(startedAt: number, timeoutSeconds: number) {
    if (timeoutSeconds === 0) return { deadline: null, timeoutMs: null, graceDeadline: null, notices: [] };
    const schedule = scheduleTimeout(startedAt, timeoutSeconds * 1000);
    return {
      deadline: schedule.deadline,
      timeoutMs: timeoutSeconds * 1000,
      graceDeadline: null,
      notices: schedule.notices,
    };
  }

  async create(ownerThreadId: string, input: z.infer<typeof createInput>) {
    const owner = await this.bb.sdk.threads.get({ threadId: ownerThreadId });
    if (!owner.environmentId || owner.archivedAt || owner.deletedAt) {
      throw new Error("Subagents need an active thread with an existing environment.");
    }
    const parent = this.byThread(ownerThreadId);
    const depth = (parent?.depth ?? 0) + 1;
    const settings = await this.settings();
    if (depth > settings.maxDepth) throw new Error(`Maximum subagent depth (${settings.maxDepth}) reached.`);
    const defaults = await this.bb.sdk.threads.defaultExecutionOptions({ threadId: ownerThreadId });
    if (!defaults) throw new Error("The original thread has no resolved execution settings yet.");
    const rootThreadId = parent?.rootThreadId ?? ownerThreadId;
    const active = this.db
      .prepare(
        `SELECT count(*) AS count FROM runs WHERE json_extract(data, '$.rootThreadId') = ? AND json_extract(data, '$.control') = 'agent' AND json_extract(data, '$.status') IN (${WORKING_SQL})`,
      )
      .get(rootThreadId) as { count: number };
    if (active.count >= settings.maxConcurrent) throw new Error("Maximum concurrent subagents reached.");
    const timeout = input.timeout ?? settings.defaultTimeout;
    const now = Date.now();
    const title = input.title ?? input.task.slice(0, 80);
    const model = input.model ?? defaults.model;
    const reasoningLevel = await this.resolveReasoningLevel(owner, model, input, defaults.reasoningLevel);
    const run: Run = {
      id: randomUUID(),
      ownerThreadId,
      rootThreadId,
      threadId: null,
      title,
      task: input.task,
      depth,
      providerId: owner.providerId,
      model,
      reasoningLevel: reasoningLevel ?? null,
      statusSummary: extractOneSentenceSummary(input.task, `Starting worker thread for ${title}.`),
      summaryUpdatedAt: now,
      createdAt: now,
      ...this.budget(now, timeout),
      resumeCount: 0,
      status: "starting",
      control: "agent",
      output: "",
      error: null,
      notifications: [],
      cleanupPending: false,
    };
    // Reserve capacity before awaiting spawn; concurrent create calls see the reservation.
    this.save(run);
    return this.serial(run.id, async () => {
      try {
        const child = await this.bb.sdk.threads.spawn({
          projectId: owner.projectId,
          environment: { type: "reuse", environmentId: owner.environmentId! },
          lifecycleOwnerThreadId: rootThreadId,
          visibility: "hidden",
          prompt: input.task,
          title: run.title,
          pluginMetadata: { runId: run.id },
          providerId: owner.providerId,
          model,
          reasoningLevel,
          permissionMode: defaults.permissionMode,
          serviceTier: defaults.serviceTier,
        });
        run.threadId = child.id;
        run.status = "running";
        run.summaryUpdatedAt = Date.now();
        this.save(run);
        await this.reconcileOne(run).catch(cause => this.bb.log.warn(`Subagent reconciliation: ${String(cause)}`));
        return this.get(run.id);
      } catch (cause) {
        run.status = "failed";
        run.error = String(cause);
        run.statusSummary = extractOneSentenceSummary(run.error, run.title);
        run.summaryUpdatedAt = Date.now();
        this.save(run);
        if (run.threadId) {
          run.cleanupPending = true;
          this.save(run);
          await this.cleanup(run);
        }
        throw cause;
      }
    });
  }

  private async cleanup(run: Run) {
    if (!run.threadId) return;
    try {
      await this.bb.sdk.threads.archive({ threadId: run.threadId });
    } finally {
      await this.bb.sdk.threads.stop({ threadId: run.threadId });
    }
    run.cleanupPending = false;
    this.save(run);
  }

  private queue(run: Run, text: string) {
    run.notifications.push(text);
    this.save(run);
  }

  private async notify(run: Run) {
    while (run.notifications.length) {
      const owner = await this.bb.sdk.threads.get({ threadId: run.ownerThreadId });
      if (owner.deletedAt || owner.archivedAt) return;
      await this.bb.sdk.threads.send({
        threadId: run.ownerThreadId,
        mode: "auto",
        input: [{ type: "text", text: run.notifications[0]!, mentions: [] }],
      });
      run.notifications.shift();
      this.save(run);
    }
  }

  private async output(run: Run) {
    if (!run.threadId) return;
    const result = await this.bb.sdk.threads.output({ threadId: run.threadId });
    run.output = (result.output ?? "").slice(0, OUTPUT_LIMIT);
  }

  /**
   * Refreshes the one-sentence status summary when the subagent emits a new
   * reply or when 30 seconds have elapsed since the last summary update.
   */
  async refreshSummaryIfNeeded(threadId: string, latestReply?: string | null) {
    const candidate = this.byThread(threadId);
    if (!candidate) return;
    await this.serial(candidate.id, async () => {
      const run = this.get(candidate.id);
      if (run.control !== "agent" || !isWorking(run)) return;
      const previousOutput = run.output;
      if (typeof latestReply === "string" && latestReply.trim()) {
        run.output = latestReply.slice(0, OUTPUT_LIMIT);
      } else if (run.threadId) {
        await this.output(run);
      }
      if (run.output && run.output !== previousOutput) {
        run.statusSummary = await this.summarize(run, run.output);
        run.summaryUpdatedAt = Date.now();
        this.save(run);
      }
    });
  }

  private async finish(run: Run, status: Run["status"], error: string | null = null) {
    run.status = status;
    run.error = error;
    run.cleanupPending = true;
    run.graceDeadline = null;
    run.notices = [];
    this.save(run);
    try {
      if (status !== "completed" && run.threadId) await this.bb.sdk.threads.stop({ threadId: run.threadId });
      await this.output(run);
      run.statusSummary = await this.summarize(run, run.output || error || "");
      run.summaryUpdatedAt = Date.now();
    } finally {
      this.queue(
        run,
        `Subagent ${JSON.stringify(run.title)} (${run.id}) ${status}. ${error ?? ""}\n${run.output}\nFull transcript: @thread:${run.threadId}${
          status !== "completed"
            ? `\nResume it with subagent_resume({ id: ${JSON.stringify(run.id)}, message? }) to continue with its context.`
            : ""
        }`,
      );
      await this.cleanup(run);
    }
    await this.notify(run);
  }

  /** Settles a worker that went idle while winding down by the verdict in its wrap-up reply. */
  private async finishWoundDown(run: Run) {
    await this.output(run).catch(cause => this.bb.log.warn(`Subagent wrap-up output: ${String(cause)}`));
    if (declaresComplete(run.output)) await this.finish(run, "completed");
    else await this.finish(run, "timed-out", WOUND_DOWN);
  }

  async settle(threadId: string, failed?: string, lastAssistantText?: string | null) {
    const candidate = this.byThread(threadId);
    if (!candidate) return;
    await this.serial(candidate.id, async () => {
      const run = this.get(candidate.id);
      if (run.control !== "agent" || !isWorking(run)) return;
      if (typeof lastAssistantText === "string" && lastAssistantText.trim()) {
        run.output = lastAssistantText.slice(0, OUTPUT_LIMIT);
      }
      if (failed) await this.finish(run, "failed", failed);
      else if (run.status === "winding-down") await this.finishWoundDown(run);
      else await this.finish(run, "completed");
    });
  }

  async kill(caller: string, id: string, reason: string) {
    return this.serial(id, async () => {
      const run = this.get(id);
      if (!this.owns(caller, run)) throw new Error("This subagent belongs to another thread.");
      if (run.control !== "agent") {
        throw new Error("The user detached this session; it cannot be killed by an agent.");
      }
      if (isWorking(run)) await this.finish(run, "killed", reason);
      return this.get(id);
    });
  }

  /**
   * Detaches a background subagent from the subagents harness and converts its
   * worker thread into a visible child thread of its parent (`ownerThreadId`).
   */
  async detach(id: string) {
    return this.serial(id, async () => {
      const run = this.get(id);
      if (!run.threadId) throw new Error("Subagent is still starting.");
      if (run.control !== "agent") {
        await this.notify(run);
        return { threadId: run.threadId };
      }
      await this.bb.sdk.threads.unarchive({ threadId: run.threadId });
      await this.bb.sdk.threads.update({
        threadId: run.threadId,
        visibility: "visible",
        parentThreadId: run.ownerThreadId,
      });
      run.control = "user";
      run.deadline = null;
      run.cleanupPending = false;
      this.queue(
        run,
        `The user detached subagent ${JSON.stringify(run.title)} (${run.id}) into child thread @thread:${run.threadId}.`,
      );
      await this.notify(run);
      return { threadId: run.threadId };
    });
  }

  private async reconcileOne(initialRun: Run) {
    const run = await this.hydrateExecution(initialRun);
    if (!run.threadId) {
      if (run.status !== "starting") return;
      // A server crash can happen after spawn commits but before the returned ID is saved.
      let offset = 0;
      while (!run.threadId) {
        const page = await this.bb.sdk.threads.list({
          originPluginId: this.bb.pluginId,
          includeHidden: true,
          archived: false,
          limit: 100,
          offset,
        });
        for (const candidate of page) {
          const metadata = await this.bb.sdk.threads.getPluginMetadata({ threadId: candidate.id });
          if (metadata.runId === run.id) {
            run.threadId = candidate.id;
            run.status = "running";
            this.save(run);
            break;
          }
        }
        if (page.length < 100) break;
        offset += 100;
      }
      if (!run.threadId) {
        run.status = "failed";
        run.error = "Interrupted before the worker thread was attached.";
        run.statusSummary = extractOneSentenceSummary(run.error, run.title);
        run.summaryUpdatedAt = Date.now();
        this.queue(run, `Subagent ${JSON.stringify(run.title)} (${run.id}) failed before its worker attached.`);
        await this.notify(run);
        return;
      }
    }
    if (run.control !== "agent") {
      await this.notify(run);
      return;
    }
    if (!isWorking(run)) {
      if (run.cleanupPending) await this.cleanup(run);
      await this.notify(run);
      return;
    }
    const child = await this.bb.sdk.threads.get({ threadId: run.threadId });
    if (child.deletedAt) {
      run.status = "failed";
      run.error = "Worker thread deleted.";
      run.statusSummary = extractOneSentenceSummary(run.error, run.title);
      run.summaryUpdatedAt = Date.now();
      this.queue(run, `Subagent ${JSON.stringify(run.title)} (${run.id}) failed: worker thread deleted.`);
      await this.notify(run);
      return;
    }
    if (child.archivedAt) {
      await this.finish(run, "killed", "Worker archived before completion.");
      return;
    }
    // A worker that finished on its own before the clock ran out completed; one that
    // went idle while winding down did what it was asked.
    if (child.status === "idle") {
      if (run.status === "winding-down") await this.finishWoundDown(run);
      else await this.finish(run, "completed");
      return;
    }
    if (child.status === "error") {
      await this.finish(run, "failed", "Worker failed; inspect its transcript.");
      return;
    }
    if (await this.enforceTimeout(run)) return;
    if (Date.now() - run.summaryUpdatedAt >= SUMMARY_INTERVAL_MS) {
      await this.output(run);
      run.statusSummary = await this.summarize(run, run.output);
      run.summaryUpdatedAt = Date.now();
      this.save(run);
    }
  }

  /**
   * Advances the timeout state machine: heads-up notices, the wind-down order at
   * the deadline, and the hard stop when the grace period ends. Returns whether
   * the run settled.
   */
  private async enforceTimeout(run: Run): Promise<boolean> {
    const now = Date.now();
    if (run.status === "winding-down") {
      if (run.graceDeadline === null || now < run.graceDeadline) return false;
      await this.finish(
        run,
        "timed-out",
        "Time limit reached; the worker did not wrap up within its grace period and was stopped.",
      );
      return true;
    }
    if (run.deadline === null) return false;
    if (now >= run.deadline) {
      const graceMs = run.timeoutMs === null ? 0 : graceMsFor(run.timeoutMs);
      if (!run.threadId || graceMs === 0) {
        await this.finish(run, "timed-out", "Subagent timeout exceeded.");
        return true;
      }
      // Record the wind-down before sending the order: delivering a steer to a worker in the
      // middle of a tool call can take many seconds, and the run should not read as running
      // while the worker is already being told to stop.
      run.status = "winding-down";
      run.graceDeadline = now + graceMs;
      run.notices = [];
      run.statusSummary = "Time limit reached; waiting for the worker to wrap up.";
      run.summaryUpdatedAt = now;
      this.save(run);
      try {
        await this.steer(run.threadId, windDownMessage(graceMs));
      } catch (cause) {
        this.bb.log.warn(`Subagent wind-down notice: ${String(cause)}`);
        await this.finish(run, "timed-out", "Subagent timeout exceeded; the worker could not be asked to wrap up.");
        return true;
      }
      // The order says "about <grace>": count that from delivery, not from the attempt.
      run.graceDeadline = Date.now() + graceMs;
      this.save(run);
      return false;
    }
    const due = run.notices.filter(at => at <= now);
    if (due.length > 0 && run.threadId && run.timeoutMs !== null) {
      // Several notices can fall due while the plugin was down; one message covers them all.
      run.notices = run.notices.filter(at => at > now);
      this.save(run);
      // Not awaited: a slow delivery must not hold up this run's lock or the other runs' checks.
      void this.steer(run.threadId, noticeMessage(run.deadline - now, run.timeoutMs, graceMsFor(run.timeoutMs))).catch(
        cause => this.bb.log.warn(`Subagent time notice: ${String(cause)}`),
      );
    }
    return false;
  }

  private async steer(threadId: string, text: string) {
    await this.bb.sdk.threads.send({
      threadId,
      mode: "steer-if-active",
      input: [{ type: "text", text, mentions: [] }],
    });
  }

  /**
   * Continues a settled worker in its existing session with a fresh time budget,
   * optionally steering it with new instructions. A completed worker has nothing
   * left to continue, so it needs those instructions.
   */
  async resume(caller: string, input: z.infer<typeof resumeInput>) {
    return this.serial(input.id, async () => {
      const run = this.get(input.id);
      if (!this.owns(caller, run)) throw new Error("This subagent belongs to another thread.");
      if (run.control !== "agent") throw new Error("The user detached this session; it cannot be resumed by an agent.");
      if (run.status === "starting" || run.status === "running" || run.status === "winding-down") {
        throw new Error(`Subagents that are still working cannot be resumed; this one is ${run.status}.`);
      }
      if (run.status === "completed" && !input.message) {
        throw new Error("A completed subagent needs a message saying what to do next.");
      }
      if (!run.threadId) throw new Error("This subagent never attached a worker thread.");
      const previous = run.status;
      const settings = await this.settings();
      const active = this.db
        .prepare(
          `SELECT count(*) AS count FROM runs WHERE json_extract(data, '$.rootThreadId') = ? AND json_extract(data, '$.control') = 'agent' AND json_extract(data, '$.status') IN (${WORKING_SQL})`,
        )
        .get(run.rootThreadId) as { count: number };
      if (active.count >= settings.maxConcurrent) throw new Error("Maximum concurrent subagents reached.");
      const child = await this.bb.sdk.threads.get({ threadId: run.threadId });
      if (child.deletedAt) throw new Error("The worker thread was deleted; it cannot be resumed.");
      const before = { ...run };
      await this.bb.sdk.threads.unarchive({ threadId: run.threadId });
      const now = Date.now();
      Object.assign(run, this.budget(now, input.timeout ?? settings.defaultTimeout), {
        status: "running",
        error: null,
        cleanupPending: false,
        resumeCount: run.resumeCount + 1,
        statusSummary: "Resumed; continuing where it left off.",
        summaryUpdatedAt: now,
      });
      this.save(run);
      try {
        await this.bb.sdk.threads.send({
          threadId: run.threadId,
          mode: "auto",
          input: [{ type: "text", text: resumeMessage(previous, input.message), mentions: [] }],
        });
      } catch (cause) {
        // The worker never received the message: restore the settled run and release it again.
        Object.assign(run, before, { cleanupPending: true });
        this.save(run);
        await this.cleanup(run).catch(failure => this.bb.log.warn(`Subagent resume rollback: ${String(failure)}`));
        throw cause;
      }
      return this.get(run.id);
    });
  }

  async reconcile() {
    for (const run of this.query("json_extract(data, '$.model') IS NULL", [], 100)) {
      if (this.disposed) return;
      await this.serial(run.id, () => this.hydrateExecution(this.get(run.id))).catch(cause =>
        this.bb.log.warn(`Subagent ${run.id}: ${String(cause)}`),
      );
    }
    for (const run of this.query(
      `(json_extract(data, '$.control') = 'agent' AND (json_extract(data, '$.status') IN (${WORKING_SQL}) OR json_extract(data, '$.cleanupPending') = 1)) OR json_array_length(data, '$.notifications') > 0`,
    )) {
      if (this.disposed) return;
      // Revisit only active runs or pending deliveries; settled runtime cleanup is retried on reload.
      if (
        (run.control === "agent" && (isWorking(run) || run.cleanupPending)) ||
        run.notifications.length
      ) {
        await this.serial(run.id, () => this.reconcileOne(this.get(run.id))).catch(cause =>
          this.bb.log.warn(`Subagent ${run.id}: ${String(cause)}`),
        );
      }
    }
  }

  async dispose() {
    this.disposed = true;
    await Promise.allSettled(this.locks.values());
  }
}
