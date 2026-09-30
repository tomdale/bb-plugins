// Walkthrough operations shared by the agent tools and the frontend RPC.
//
// One active walkthrough exists per thread. SQLite is the source of truth;
// `<session-root>/.agent/review-notes.md` is a rendered mirror written on the
// thread's own host through bb.sdk.files once the first note exists.
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { renderNotesMarkdown } from "./model.ts";
import { filterPatchToRange } from "./patch.ts";
import type { DiffResult } from "./rpc.ts";
import {
  CHANGED_CHANNEL,
  type Group,
  type Location,
  type Mode,
  type Note,
  type NoteKind,
  type NoteStatus,
  type Walkthrough,
  type WalkthroughView,
} from "./schemas.ts";
import type { WalkthroughStore } from "./store.ts";

export class WalkthroughError extends Error {}

export interface StartInput {
  mode: Mode;
  title: string;
  baseRef: string;
  headRef?: string | undefined;
  includeUncommitted?: boolean | undefined;
  pr?: { number: number; url?: string | undefined; title?: string | undefined } | undefined;
  groups: Array<Pick<Group, "title" | "summary" | "locations">>;
  replace?: boolean | undefined;
}

export interface NoteInput {
  kind: NoteKind;
  text: string;
  /** Zero-based; undefined attaches the note to the current group. */
  groupIndex?: number | null | undefined;
  location?: Location | null | undefined;
  quote?: string | null | undefined;
}

export interface NotePatch {
  kind?: NoteKind | undefined;
  text?: string | undefined;
  status?: NoteStatus | undefined;
  resolution?: string | null | undefined;
}

interface Workspace {
  environmentId: string | null;
  hostId: string | null;
  path: string | null;
}

const MAX_FULL_FILE_BYTES = 1_000_000;
const MERGE_BASE_TTL_MS = 60_000;

export class WalkthroughService {
  /** Reports whether the pause controls are open; set by the PauseController. */
  pauseOpen: (threadId: string) => boolean = () => false;
  /** Serializes notes-file writes per walkthrough so renders land in order. */
  private readonly fileWrites = new Map<string, Promise<void>>();
  private readonly mergeBases = new Map<string, { sha: string | null; expiresAt: number }>();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: WalkthroughStore,
    private readonly now: () => number = Date.now,
  ) {}

  // -- lookup ---------------------------------------------------------------

  active(threadId: string): Walkthrough | null {
    return this.store.activeForThread(threadId);
  }

  requireActive(threadId: string): Walkthrough {
    const walkthrough = this.active(threadId);
    if (walkthrough === null) {
      throw new WalkthroughError("This thread has no walkthrough in progress. Start one with walkthrough_start.");
    }
    return walkthrough;
  }

  view(threadId: string): WalkthroughView | null {
    const walkthrough = this.store.latestForThread(threadId);
    if (walkthrough === null) return null;
    const pausePending = walkthrough.status !== "finished" && this.pauseOpen(threadId);
    return {
      walkthrough,
      notes: this.store.notes(walkthrough.id),
      pausePending,
      pauseRequested: walkthrough.status !== "finished" && walkthrough.pause !== null && !pausePending,
    };
  }

  notes(walkthroughId: string): Note[] {
    return this.store.notes(walkthroughId);
  }

  takeUnreported(walkthroughId: string): Note[] {
    return this.store.takeUnreported(walkthroughId);
  }

  markAllReported(walkthroughId: string): void {
    this.store.markAllReported(walkthroughId);
  }

  // -- lifecycle ------------------------------------------------------------

  async start(threadId: string, input: StartInput): Promise<Walkthrough> {
    const existing = this.active(threadId);
    if (existing !== null) {
      if (!input.replace) {
        throw new WalkthroughError(
          `This thread already has a walkthrough in progress (${JSON.stringify(existing.title)}). Continue it, or pass replace: true to close it and start over.`,
        );
      }
      this.save({ ...existing, status: "finished", updatedAt: this.now() });
    }
    const workspace = await this.resolveWorkspace(threadId);
    const root = workspace.path;
    const now = this.now();
    const walkthrough: Walkthrough = {
      id: `wt_${randomUUID().replace(/-/gu, "").slice(0, 12)}`,
      threadId,
      mode: input.mode,
      status: "overview",
      title: input.title,
      baseRef: input.baseRef,
      headRef: input.headRef ?? null,
      includeUncommitted: input.includeUncommitted ?? input.mode === "local",
      pr:
        input.mode === "pr" && input.pr
          ? { number: input.pr.number, url: input.pr.url || null, title: input.pr.title || null }
          : null,
      groups: input.groups.map((group): Group => ({ ...group, status: "pending" })),
      currentGroup: null,
      environmentId: workspace.environmentId,
      hostId: workspace.hostId,
      workspacePath: workspace.path,
      notesFile: {
        enabled: true,
        path: root ? `${root}/.agent/review-notes.md` : null,
        written: false,
        error: null,
      },
      review: null,
      pause: null,
      nextNoteNumber: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.save(walkthrough, "started");
    return walkthrough;
  }

  /** Persists a walkthrough and tells open clients to refetch. */
  save(walkthrough: Walkthrough, reason: "started" | "changed" = "changed"): void {
    this.store.save(walkthrough);
    this.publish(walkthrough.threadId, reason);
  }

  publish(threadId: string, reason: "started" | "changed" = "changed"): void {
    const walkthrough = this.store.latestForThread(threadId);
    this.bb.realtime.publish(CHANGED_CHANNEL, { threadId, reason, walkthroughId: walkthrough?.id ?? null });
  }

  // -- notes ----------------------------------------------------------------

  addNote(threadId: string, input: NoteInput, author: Note["author"]): Note {
    const walkthrough = this.requireActive(threadId);
    const groupIndex = input.groupIndex === undefined ? walkthrough.currentGroup : input.groupIndex;
    if (groupIndex !== null && (groupIndex < 0 || groupIndex >= walkthrough.groups.length)) {
      throw new WalkthroughError(`Group ${groupIndex + 1} does not exist; the outline has ${walkthrough.groups.length} groups.`);
    }
    const now = this.now();
    const note: Note = {
      id: `n${walkthrough.nextNoteNumber}`,
      walkthroughId: walkthrough.id,
      kind: input.kind,
      text: input.text.trim(),
      groupIndex,
      location: input.location ?? null,
      quote: input.quote?.trim() || null,
      status: "open",
      resolution: null,
      author,
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveNote(note, author === "agent");
    this.save({ ...walkthrough, nextNoteNumber: walkthrough.nextNoteNumber + 1, updatedAt: now });
    this.syncNotesFile(walkthrough.id);
    return note;
  }

  updateNote(threadId: string, noteId: string, patch: NotePatch, author: Note["author"]): Note {
    const walkthrough = this.requireLatest(threadId);
    const note = this.store.note(walkthrough.id, noteId);
    if (note === null) throw new WalkthroughError(`No note ${JSON.stringify(noteId)} in this walkthrough.`);
    const status = patch.status ?? note.status;
    const next: Note = {
      ...note,
      kind: patch.kind ?? note.kind,
      text: patch.text?.trim() || note.text,
      status,
      resolution: patch.resolution === undefined ? note.resolution : patch.resolution?.trim() || null,
      updatedAt: this.now(),
    };
    this.store.saveNote(next, author === "agent");
    this.publish(threadId);
    this.syncNotesFile(walkthrough.id);
    return next;
  }

  deleteNote(threadId: string, noteId: string): boolean {
    const walkthrough = this.requireLatest(threadId);
    const deleted = this.store.deleteNote(walkthrough.id, noteId);
    if (deleted) {
      this.publish(threadId);
      this.syncNotesFile(walkthrough.id);
    }
    return deleted;
  }

  setNotesFileEnabled(threadId: string, enabled: boolean): void {
    const walkthrough = this.requireLatest(threadId);
    this.save({ ...walkthrough, notesFile: { ...walkthrough.notesFile, enabled }, updatedAt: this.now() });
    if (enabled) this.syncNotesFile(walkthrough.id);
  }

  requireLatest(threadId: string): Walkthrough {
    const walkthrough = this.store.latestForThread(threadId);
    if (walkthrough === null) throw new WalkthroughError("This thread has no walkthrough.");
    return walkthrough;
  }

  /**
   * Queues a rewrite of the notes mirror. The file appears only after the
   * first note exists, matching the rule that `.agent/` is created lazily.
   */
  syncNotesFile(walkthroughId: string): Promise<void> {
    const previous = this.fileWrites.get(walkthroughId) ?? Promise.resolve();
    const run = previous.then(() => this.writeNotesFile(walkthroughId));
    const settled = run.catch(() => {});
    this.fileWrites.set(walkthroughId, settled);
    void settled.then(() => {
      if (this.fileWrites.get(walkthroughId) === settled) this.fileWrites.delete(walkthroughId);
    });
    return settled;
  }

  private async writeNotesFile(walkthroughId: string): Promise<void> {
    const walkthrough = this.store.get(walkthroughId);
    if (walkthrough === null || !walkthrough.notesFile.enabled || walkthrough.notesFile.path === null) return;
    const notes = this.store.notes(walkthroughId);
    if (notes.length === 0 && !walkthrough.notesFile.written) return;
    let error: string | null = null;
    try {
      await this.bb.sdk.files.write({
        ...(walkthrough.hostId ? { hostId: walkthrough.hostId } : {}),
        path: walkthrough.notesFile.path,
        content: renderNotesMarkdown(walkthrough, notes),
        createParents: true,
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      this.bb.log.warn(`notes file write failed for ${walkthroughId}: ${error}`);
    }
    const latest = this.store.get(walkthroughId);
    if (latest === null) return;
    const written = latest.notesFile.written || error === null;
    if (latest.notesFile.written !== written || latest.notesFile.error !== error) {
      this.save({ ...latest, notesFile: { ...latest.notesFile, written, error } });
    }
  }

  // -- diffs ----------------------------------------------------------------

  async diff(
    threadId: string,
    path: string,
    range: { startLine?: number | undefined; endLine?: number | undefined },
    withFullFile: boolean,
  ): Promise<DiffResult> {
    const walkthrough = this.store.latestForThread(threadId);
    if (walkthrough === null) return { outcome: "unavailable", message: "This thread has no walkthrough." };
    const environmentId = walkthrough.environmentId ?? (await this.resolveWorkspace(threadId)).environmentId;
    if (environmentId === null) return { outcome: "unavailable", message: "This thread has no workspace to diff." };
    const type = walkthrough.includeUncommitted ? "all" : "branch_committed";
    try {
      const response = await this.bb.sdk.environments.diffPatch({
        environmentId,
        paths: [path],
        target: { type, mergeBaseBranch: walkthrough.baseRef },
      });
      if (response.outcome !== "available") {
        return {
          outcome: "unavailable",
          message: response.outcome === "not_applicable" ? response.message : response.failure.message,
        };
      }
      const file = response.patches.find((candidate) => candidate.path === path) ?? response.patches[0];
      if (file === undefined || file.patch.trim() === "") {
        return { outcome: "unavailable", message: `${path} has no changes against ${walkthrough.baseRef}.` };
      }
      const start = range.startLine;
      const narrowed =
        start === undefined ? { patch: file.patch, filtered: false } : filterPatchToRange(file.patch, start, range.endLine ?? start);
      const fullFileContents =
        withFullFile && !narrowed.filtered ? await this.fullFile(environmentId, walkthrough, path, file.patch) : null;
      return {
        outcome: "available",
        path,
        patch: narrowed.patch,
        truncated: file.truncated,
        filtered: narrowed.filtered,
        fullFileContents,
      };
    } catch (cause) {
      return { outcome: "unavailable", message: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /** The merge-base SHA diffFile needs, cached briefly per environment and base. */
  private async mergeBase(environmentId: string, walkthrough: Walkthrough): Promise<string | null> {
    const key = `${environmentId}\u0000${walkthrough.baseRef}\u0000${walkthrough.includeUncommitted}`;
    const cached = this.mergeBases.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.sha;
    const response = await this.bb.sdk.environments.diffFiles({
      environmentId,
      target: walkthrough.includeUncommitted ? "all" : "branch_committed",
      mergeBaseBranch: walkthrough.baseRef,
    });
    const sha = response.outcome === "available" ? response.mergeBaseRef : null;
    this.mergeBases.set(key, { sha, expiresAt: this.now() + MERGE_BASE_TTL_MS });
    return sha;
  }

  private async fullFile(environmentId: string, walkthrough: Walkthrough, path: string, patch: string) {
    const target = walkthrough.includeUncommitted ? "all" : "branch_committed";
    const mergeBaseRef = await this.mergeBase(environmentId, walkthrough).catch(() => null);
    if (mergeBaseRef === null) return null;
    // An added file has no old side and a deleted file no new side; both
    // render with an empty counterpart.
    const absent = { old: /^--- \/dev\/null$/mu.test(patch), new: /^\+\+\+ \/dev\/null$/mu.test(patch) };
    const side = async (which: "old" | "new") => {
      if (absent[which]) return { path, content: "" };
      try {
        const file = await this.bb.sdk.environments.diffFile({
          environmentId,
          path,
          side: which,
          target,
          mergeBaseRef,
        });
        if (file.contentEncoding !== "utf8" || file.sizeBytes > MAX_FULL_FILE_BYTES) return null;
        return { path, content: file.content };
      } catch (cause) {
        this.bb.log.debug(`full ${which} side unavailable for ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      }
    };
    const [old, current] = await Promise.all([side("old"), side("new")]);
    return old && current ? { old, new: current } : null;
  }

  // -- agent messages ---------------------------------------------------------

  /**
   * Sends a user-attributed message: `visible` shows in the transcript and
   * `agent` reaches only the agent.
   */
  async sendMessage(threadId: string, message: { visible: string; agent?: string }): Promise<void> {
    await this.bb.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [
        { type: "text", text: message.visible, mentions: [] },
        ...(message.agent ? [{ type: "text" as const, text: message.agent, mentions: [], visibility: "agent-only" as const }] : []),
      ],
    });
  }

  // -- workspace --------------------------------------------------------------

  private async resolveWorkspace(threadId: string): Promise<Workspace> {
    try {
      const thread = await this.bb.sdk.threads.get({ threadId });
      if (!thread.environmentId) return { environmentId: null, hostId: null, path: null };
      const environment = await this.bb.sdk.environments.get({ environmentId: thread.environmentId });
      return { environmentId: environment.id, hostId: environment.hostId, path: environment.path };
    } catch (cause) {
      this.bb.log.warn(`workspace lookup failed for ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return { environmentId: null, hostId: null, path: null };
    }
  }
}
