// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it } from "vitest";

const subject = "Plan the release";
const idleSnapshot = () => ({ tasks: [{ id: 1, subject, status: "pending" as const }], nextId: 2 });
afterEach(() => {
  cleanup();
  document.querySelectorAll("[data-thread-window]").forEach(element => element.remove());
});

async function mount(
  snapshot: () => unknown = idleSnapshot,
  settings: Record<string, unknown> = {},
  sideGutter = false,
) {
  const app = await loadPluginApp(() => import("./app.js"));
  const banner = app.composerCustomizations[0]!.banners![0]!;
  const slot = renderSlot(banner, {}, {
    composer: { scope: { kind: "thread", threadId: "thread-a" } },
    rpc: { snapshot },
    settings,
  });
  const footer = document.createElement("div");
  footer.setAttribute("data-scroll-footer", "");
  footer.dataset.testSideGutter = String(sideGutter);
  const threadWindow = document.createElement("div");
  threadWindow.setAttribute("data-thread-window", "");
  const scrollArea = document.createElement("div");
  Object.defineProperty(scrollArea, "clientHeight", { value: 700 });
  Object.defineProperty(scrollArea, "scrollHeight", { value: 1200 });
  scrollArea.style.overflowY = "auto";
  const messageColumn = document.createElement("div");
  messageColumn.setAttribute("data-message-column", "");
  Object.defineProperty(messageColumn, "clientWidth", { value: 700 });
  messageColumn.getBoundingClientRect = () => ({ x: 0, y: 300, left: 0, right: 700, top: 300, bottom: 500, width: 700, height: 200, toJSON: () => ({}) } as DOMRect);
  scrollArea.append(messageColumn);
  scrollArea.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, right: sideGutter ? 1500 : 1000, top: 0, bottom: 700, width: sideGutter ? 1500 : 1000, height: 700, toJSON: () => ({}) } as DOMRect);
  footer.getBoundingClientRect = () => ({ x: 0, y: 650, left: 0, right: sideGutter ? 1500 : 1000, top: 650, bottom: 700, width: sideGutter ? 1500 : 1000, height: 50, toJSON: () => ({}) } as DOMRect);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: sideGutter ? 1500 : 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  threadWindow.append(scrollArea);
  scrollArea.append(messageColumn, footer);
  footer.append(slot.container);
  document.body.append(threadWindow);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return slot;
}

it("registers a native thread Todo editor panel", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  expect(app.threadPanelActions.map(action => action.id)).toContain("todos");
  expect(app.threadHeaderActions.map(action => action.id)).toContain("todos");
  const panel = app.threadPanelActions.find(action => action.id === "todos")!;
  const slot = renderSlot(panel, { threadId: "thread-a", params: null }, {
    rpc: { snapshot: () => ({ tasks: [], nextId: 1 }), mutate: () => ({ tasks: [{ id: 1, subject: "New todo", status: "pending" }], nextId: 2 }) },
  });
  await slot.findByLabelText("New todo");
  slot.lifecycle.unmount();
});

it("uses the right-side gutter beside the latest visible message when it fits", async () => {
  const slot = await mount(idleSnapshot, {}, true);
  const liveAnchor = document.querySelector<HTMLElement>("[data-message-column]")!;
  Object.defineProperty(liveAnchor, "clientWidth", { value: 700 });
  liveAnchor.getBoundingClientRect = () => ({ x: 0, y: 300, left: 0, right: 700, top: 300, bottom: 500, width: 700, height: 200, toJSON: () => ({}) } as DOMRect);
  const liveArea = liveAnchor.parentElement!;
  liveArea.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, right: 1500, top: 0, bottom: 700, width: 1500, height: 700, toJSON: () => ({}) } as DOMRect);
  const scrollArea = liveArea.parentElement!;
  scrollArea.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, right: 1500, top: 0, bottom: 700, width: 1500, height: 700, toJSON: () => ({}) } as DOMRect);
  const footer = scrollArea.querySelector<HTMLElement>("[data-scroll-footer]")!;
  footer.getBoundingClientRect = () => ({ x: 0, y: 650, left: 0, right: 1500, top: 650, bottom: 700, width: 1500, height: 50, toJSON: () => ({}) } as DOMRect);
  const card = await slot.findByText(subject);
  await waitFor(() => expect(document.querySelector(".todo-card")?.getAttribute("data-floating")).toBe(""));
  expect(document.querySelector<HTMLElement>(".todo-card")?.style.left).toBe("712px");
  slot.lifecycle.unmount();
});

it("keeps queued-message cards in their own composer instead of claiming the thread gutter", async () => {
  const slot = await mount(idleSnapshot, {}, true);
  await slot.behavior.setComposerScope({ kind: "queued-message", threadId: "thread-a", queuedMessageId: "queue-1" });
  await slot.findByText(subject);
  await waitFor(() => expect(document.querySelector(".todo-card")?.getAttribute("data-floating")).toBeNull());
  slot.lifecycle.unmount();
});

it("keeps the card in the composer when no measurable side gutter is available", async () => {
  const slot = await mount();
  const card = await slot.findByText(subject);
  expect(card.closest(".todo-card")?.getAttribute("data-floating")).toBeNull();
  slot.lifecycle.unmount();
});

it("announces a stale in-progress snapshot as pending while idle", async () => {
  const slot = await mount(() => ({ tasks: [{ id: 1, subject, status: "in_progress" as const }], nextId: 2 }));
  const row = await slot.findByText(subject);
  const listItem = row.closest("li");
  expect(listItem?.textContent).toContain("Pending:");
  expect(listItem?.className).toContain("todo-row-pending");
  expect(listItem?.querySelector(".todo-row-spinner")).toBeNull();
  slot.lifecycle.unmount();
});

it("hides a completed card after the configured delay and shows it again when tasks change", async () => {
  let current = { tasks: [{ id: 1, subject, status: "completed" as const }], nextId: 2 };
  const slot = await mount(() => current, { completedHideDelaySeconds: 0.05 });
  await slot.findByText(subject);
  await waitFor(() => expect(slot.queryByText(subject)).toBeNull());
  current = { tasks: [{ id: 1, subject, status: "completed" as const }, { id: 2, subject: "Next task", status: "pending" as const }], nextId: 3 };
  await slot.behavior.emitRealtime("todo-changed", { threadId: "thread-a" });
  await slot.findByText("Next task");
  slot.lifecycle.unmount();
});

it("restarts the completion delay after another completed-list mutation", async () => {
  let current = { tasks: [{ id: 1, subject, status: "completed" as const }], nextId: 2 };
  const slot = await mount(() => current, { completedHideDelaySeconds: 0.15 });
  await slot.findByText(subject);
  await new Promise(resolve => setTimeout(resolve, 90));
  current = { tasks: [{ id: 1, subject: "Updated completed task", status: "completed" as const }], nextId: 2 };
  await slot.behavior.emitRealtime("todo-changed", { threadId: "thread-a" });
  await slot.findByText("Updated completed task");
  await new Promise(resolve => setTimeout(resolve, 90));
  expect(slot.getByText("Updated completed task")).toBeTruthy();
  await waitFor(() => expect(slot.queryByText("Updated completed task")).toBeNull());
  slot.lifecycle.unmount();
});
