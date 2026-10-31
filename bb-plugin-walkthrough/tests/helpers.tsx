// Shared fixtures for the reader tests.
import { act, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { mergedReviewDraft } from "../src/model.ts";
import { deliverNote, deliverWalkthrough } from "../src/deliver.ts";
import type { DeliveredNote as Note, DeliveredPart as Part, DeliveredWalkthrough as Walkthrough } from "../src/schemas.ts";

export const PLUGIN_ID = "walkthrough";

export function part(title: string, overrides: Record<string, unknown> = {}): Part {
  return {
    title,
    summary: "",
    locations: [],
    status: "ready",
    blocks: [{ kind: "prose", text: `${title} prose.` }],
    suggestions: [],
    message: null,
    discussion: [],
    ...overrides,
  } as Part;
}

/** A walkthrough as the pane receives it: older-shaped fixtures get the same backfill the server applies. */
export function walkthrough(overrides: Record<string, unknown> = {}): Walkthrough {
  return deliverWalkthrough({
    id: "wt_1",
    threadId: "thr_1",
    workerThreadId: "thr_w",
    request: "Walk me through it",
    status: "reading",
    message: null,
    title: "Branch feature",
    mode: "local",
    baseRef: "origin/main",
    includeUncommitted: true,
    pr: null,
    introduction: "",
    parts: [part("Schema", { blocks: [{ kind: "prose", text: "The schema comes first." }] })],
    currentPart: 0,
    wrapUp: null,
    environmentId: "env_1",
    hostId: "host_1",
    workspacePath: "/w",
    review: null,
    queue: [],
    inFlight: null,
    nextNoteNumber: 1,
    nextExchangeNumber: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as never);
}

export function note(overrides: Record<string, unknown> = {}): Note {
  return deliverNote({ id: "n1", walkthroughId: "wt_1", kind: "todo", text: "Check this", groupIndex: 0, location: null, quote: null, status: "open", resolution: null, author: "user", createdAt: 1, updatedAt: 1, ...overrides } as never);
}

/** Stubs ResizeObserver so the reader sees `width` as its own width. */
export function stubWidth(width: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: (entries: Array<{ contentRect: { width: number } }>) => void) {}
      observe() {
        this.callback([{ contentRect: { width } }]);
      }
      disconnect() {}
      unobserve() {}
    },
  );
}

export const mounted: Array<{ lifecycle?: { unmount: () => void }; unmount: () => void }> = [];

export async function mountPage(subPath: string, rpc: Record<string, (input: never) => unknown>, options: Record<string, unknown> = {}) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const registration = app.navPanels.find((panel) => panel.path === "walkthroughs")!;
  const slot = renderSlot(registration, { subPath }, { pluginId: PLUGIN_ID, rpc: rpc as never, ...options });
  mounted.push(slot as never);
  return slot;
}

export async function mountPanel(params: unknown, rpc: Record<string, (input: never) => unknown>, options: Record<string, unknown> = {}) {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thr_1", params: params as never }, { pluginId: PLUGIN_ID, rpc: rpc as never, ...options });
  mounted.push(slot as never);
  return slot;
}

export const viewOf = (w: Walkthrough, notes: Note[] = []) => ({ get: () => ({ view: { walkthrough: w, notes, reviewDraft: mergedReviewDraft(w, notes) } }) });

/** Opens a Radix dropdown the way a pointer does. */
export function openMenu(trigger: HTMLElement) {
  act(() => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  });
}

/**
 * A walkthrough whose `openPart` moves the page the way the server does: the
 * call updates currentPart, and the next `get` (after a "changed" signal) shows it.
 */
export function pagedView(initial: Walkthrough, notes: Note[] = []) {
  const state = { current: initial };
  const rpc = {
    get: () => ({ view: { walkthrough: state.current, notes, reviewDraft: mergedReviewDraft(state.current, notes) } }),
    openPart: ({ index }: { index: number | null }) => {
      state.current = { ...state.current, currentPart: index } as Walkthrough;
      return { ok: true };
    },
  };
  const changed = (slot: { emitRealtime: (channel: string, payload: unknown) => Promise<unknown> | unknown }) => slot.emitRealtime("walkthrough-changed", { threadId: "thr_1", walkthroughId: "wt_1", reason: "changed" });
  return { state, rpc, changed };
}
