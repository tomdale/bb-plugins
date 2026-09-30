// Opens the pause controls once the agent's turn has ended and turns the
// user's choice into state plus a chat message.
//
// walkthrough_pause only records the request, so the agent can still write
// the step's content as the last (and therefore visible) message of its turn.
// The form opens on thread.idle, never mid-turn, and the choice arrives as a
// user-attributed message so the transcript shows what the user did.
import type { BbPluginApi, PluginInteractionResult } from "@get-bb/plugin-sdk";
import { applyPauseResponse, pauseStage } from "./model.ts";
import { pauseChoiceMessage } from "./messages.ts";
import {
  PAUSE_RENDERER_ID,
  pauseResponseSchema,
  type PausePayload,
  type PauseResponse,
  type Walkthrough,
} from "./schemas.ts";
import type { WalkthroughService } from "./service.ts";

/** One requestInput window; bb caps a single form at one hour. */
const PAUSE_WINDOW_MS = 60 * 60 * 1000;
/** The controls reopen after each window until this much time has passed. */
const PAUSE_MAX_MS = 24 * 60 * 60 * 1000;

export function pausePayload(walkthrough: Walkthrough): PausePayload | null {
  const stage = pauseStage(walkthrough);
  if (stage === null || walkthrough.pause === null) return null;
  const index = walkthrough.currentGroup;
  const upcoming = walkthrough.groups.findIndex((group) => group.status === "pending");
  return {
    walkthroughId: walkthrough.id,
    mode: walkthrough.mode,
    stage,
    groupIndex: index,
    groupCount: walkthrough.groups.length,
    groupTitle: index === null ? null : walkthrough.groups[index]!.title,
    nextGroupTitle: stage === "finish" || upcoming < 0 ? null : walkthrough.groups[upcoming]!.title,
    suggestions: walkthrough.pause.suggestions,
    locations: index === null ? [] : walkthrough.groups[index]!.locations,
    environmentId: walkthrough.environmentId,
  };
}

/** The pause form's title, which BB shows in the interaction card header. */
export function pauseTitle(payload: PausePayload): string {
  if (payload.stage === "overview") return `Walkthrough overview · ${payload.groupCount} groups`;
  if (payload.stage === "finish") return "Walkthrough finish";
  return `Group ${(payload.groupIndex ?? 0) + 1} of ${payload.groupCount}: ${payload.groupTitle ?? ""}`;
}

function describeChoice(payload: PausePayload, response: PauseResponse): { title: string } {
  switch (response.action) {
    case "next":
      return { title: payload.nextGroupTitle ? `Next: ${payload.nextGroupTitle}` : "Finished the last group" };
    case "finish":
      return { title: "Finished the walkthrough" };
    case "complete":
      return { title: "Closed the walkthrough" };
    case "ask":
      return { title: "Asked a question" };
  }
}

export class PauseController {
  /** threadId → abort for pause forms this server generation holds open. */
  private readonly open = new Map<string, AbortController>();
  private disposed = false;

  constructor(
    private readonly bb: BbPluginApi,
    private readonly service: WalkthroughService,
  ) {}

  isOpen(threadId: string): boolean {
    return this.open.has(threadId);
  }

  /**
   * Opens the controls when the thread's walkthrough has a pause request.
   * `explicit` reopens controls the user dismissed; other callers first
   * confirm the thread is idle with nothing queued.
   */
  async maybeOpen(threadId: string, reason: "idle" | "explicit" | "startup"): Promise<boolean> {
    if (this.disposed || this.open.has(threadId)) return false;
    const walkthrough = this.service.active(threadId);
    if (walkthrough === null || walkthrough.pause === null) return false;
    if (walkthrough.pause.dismissed && reason !== "explicit") return false;
    if (reason !== "idle") {
      const thread = await this.bb.sdk.threads.get({ threadId }).catch(() => null);
      if (thread === null || thread.status !== "idle" || thread.queuedMessageCount > 0) return false;
    }
    if (walkthrough.pause.dismissed) {
      this.service.save({ ...walkthrough, pause: { ...walkthrough.pause, dismissed: false } });
    }
    const payload = pausePayload(walkthrough);
    if (payload === null) return false;
    const controller = new AbortController();
    this.open.set(threadId, controller);
    this.service.publish(threadId);
    void this.run(threadId, payload, controller).finally(() => {
      if (this.open.get(threadId) === controller) this.open.delete(threadId);
      if (!this.disposed) this.service.publish(threadId);
    });
    return true;
  }

  private async run(threadId: string, payload: PausePayload, controller: AbortController): Promise<void> {
    const openedAt = Date.now();
    let outcome: PluginInteractionResult;
    for (;;) {
      try {
        outcome = await this.bb.ui.requestInput(
          {
            threadId,
            rendererId: PAUSE_RENDERER_ID,
            title: pauseTitle(payload),
            payload,
            timeoutMs: PAUSE_WINDOW_MS,
            presentation: {
              label: { pending: "Walkthrough paused", completed: "Walkthrough continued" },
              icon: { glyph: "Explore" },
              suppress: true,
            },
            describeSubmission: (value) => {
              const parsed = pauseResponseSchema.safeParse(value);
              return parsed.success ? describeChoice(payload, parsed.data) : {};
            },
          },
          { signal: controller.signal },
        );
      } catch (cause) {
        this.bb.log.warn(`pause controls failed for ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        return;
      }
      const expired = outcome.outcome === "cancelled" && outcome.reason === "timeout";
      if (!expired || Date.now() - openedAt >= PAUSE_MAX_MS || controller.signal.aborted) break;
    }
    if (outcome.outcome === "cancelled") {
      if (outcome.reason === "user" || outcome.reason === "timeout") this.markDismissed(threadId, payload.walkthroughId);
      return;
    }
    const parsed = pauseResponseSchema.safeParse(outcome.value);
    if (!parsed.success) return;
    await this.apply(threadId, payload.walkthroughId, parsed.data);
  }

  private markDismissed(threadId: string, walkthroughId: string): void {
    const current = this.service.active(threadId);
    if (current === null || current.id !== walkthroughId || current.pause === null) return;
    this.service.save({ ...current, pause: { ...current.pause, dismissed: true } });
  }

  /** Applies a choice and hands it to the agent as a chat message. */
  async apply(threadId: string, walkthroughId: string, response: PauseResponse): Promise<void> {
    const previous = this.service.active(threadId);
    if (previous === null || previous.id !== walkthroughId) return;
    const next = { ...applyPauseResponse(previous, response, Date.now()), pause: null };
    this.service.save(next);
    const fresh = this.service.takeUnreported(walkthroughId);
    const notes = this.service.notes(walkthroughId);
    if (next.status === "finishing") this.service.markAllReported(walkthroughId);
    const message = pauseChoiceMessage(previous, next, response, notes, fresh);
    if (message === null) return;
    try {
      await this.service.sendMessage(threadId, message);
    } catch (cause) {
      this.bb.log.error(`could not deliver the walkthrough choice to ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      // Undo the transition so the choice can be made again from the panel.
      this.service.save({ ...previous, pause: previous.pause && { ...previous.pause, dismissed: true } });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.open.values()) controller.abort();
    this.open.clear();
  }
}
