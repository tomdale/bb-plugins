// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import { apply, type Input, type State } from "./model.js";

const subject = "Plan the release";
const idleSnapshot = () => ({ tasks: [{ id: 1, subject, status: "pending" as const }], nextId: 2 });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

/** An in-memory server that runs the real reducer, so panel edits are validated like production. */
function todoServer(initial: State) {
  let state = initial;
  return {
    get state() { return state; },
    rpc: {
      snapshot: () => state,
      mutate: ({ change }: { change: Input }) => { state = apply(state, change).state; return state; },
    },
  };
}

async function mountPanel(initial: State) {
  const app = await loadPluginApp(() => import("./app.js"));
  const panel = app.threadPanelActions.find(action => action.id === "todos")!;
  const server = todoServer(initial);
  const slot = renderSlot(panel, { threadId: "thread-a", params: null }, { rpc: server.rpc });
  return { slot, server };
}

it("registers the Todos panel, header action and composer banner", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  expect(app.threadPanelActions.find(action => action.id === "todos")?.layout).toBe("flush");
  expect(app.threadHeaderActions.map(action => action.id)).toContain("todos");
  expect(app.composerCustomizations[0]?.banners?.[0]?.chrome).toBe("bare");
});

it("adds todos from the panel and shows an empty state before the first one", async () => {
  const { slot, server } = await mountPanel({ tasks: [], nextId: 1 });
  await slot.findByText("No todos in this thread");
  const input = slot.getByLabelText("New todo");
  fireEvent.change(input, { target: { value: "  Write the report  " } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(server.state.tasks).toEqual([{ id: 1, subject: "Write the report", status: "pending" }]));
  expect((slot.getByLabelText("Subject for #1") as HTMLInputElement).value).toBe("Write the report");
  expect((input as HTMLInputElement).value).toBe("");
  slot.lifecycle.unmount();
});

it("renders hierarchy and blockers in the panel and edits subjects on commit", async () => {
  const { slot, server } = await mountPanel({ tasks: [
    { id: 1, subject: "Parent", status: "pending" },
    { id: 2, subject: "Child", status: "pending", parentId: 1, blockedBy: [3] },
    { id: 3, subject: "Prerequisite", status: "in_progress" },
  ], nextId: 4 });
  const subtasks = await slot.findByRole("list", { name: "Subtasks of #1" });
  expect(within(subtasks).getByLabelText("Subject for #2")).toBeTruthy();
  expect(slot.getByTitle("Waiting for #3").textContent).toContain("after #3");
  expect(slot.getByRole("status").textContent).toContain("0 of 3 complete");
  const subject = slot.getByLabelText("Subject for #1");
  fireEvent.change(subject, { target: { value: "Renamed parent" } });
  fireEvent.keyDown(subject, { key: "Enter" });
  await waitFor(() => expect(server.state.tasks[0]?.subject).toBe("Renamed parent"));
  fireEvent.change(subject, { target: { value: "   " } });
  fireEvent.blur(subject);
  expect((subject as HTMLInputElement).value).toBe("Renamed parent");
  fireEvent.change(subject, { target: { value: "Discarded" } });
  fireEvent.keyDown(subject, { key: "Escape" });
  expect((subject as HTMLInputElement).value).toBe("Renamed parent");
  slot.lifecycle.unmount();
});

it("summarizes concurrent tasks in the Todos panel", async () => {
  const { slot } = await mountPanel({ tasks: [
    { id: 1, subject: "First", status: "in_progress" },
    { id: 2, subject: "Second", status: "in_progress" },
  ], nextId: 3 });
  await slot.findByRole("status");
  expect(slot.getByRole("status").textContent).toContain("2 todos in progress");
  slot.lifecycle.unmount();
});

it("edits dependencies and details from the disclosure", async () => {
  const { slot, server } = await mountPanel({ tasks: [
    { id: 1, subject: "First", status: "pending" },
    { id: 2, subject: "Second", status: "pending", blockedBy: [1] },
  ], nextId: 3 });
  const toggle = await slot.findByRole("button", { name: "Show details for #2" });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const details = slot.getByRole("group", { name: "Details for #2" });
  fireEvent.click(within(details).getByRole("button", { name: "Remove blocker #1" }));
  await waitFor(() => expect(server.state.tasks[1]?.blockedBy).toBeUndefined());
  fireEvent.change(within(details).getByLabelText("Add blocker for #2"), { target: { value: "1" } });
  await waitFor(() => expect(server.state.tasks[1]?.blockedBy).toEqual([1]));
  const owner = within(details).getByLabelText("Owner");
  fireEvent.change(owner, { target: { value: "opus" } });
  fireEvent.blur(owner);
  await waitFor(() => expect(server.state.tasks[1]?.owner).toBe("opus"));
  slot.lifecycle.unmount();
});

it("reorders and nests tasks with keyboard shortcuts on the subject field", async () => {
  const { slot, server } = await mountPanel({ tasks: [
    { id: 1, subject: "First", status: "pending" },
    { id: 2, subject: "Second", status: "pending" },
  ], nextId: 3 });
  const second = await slot.findByLabelText("Subject for #2");
  fireEvent.keyDown(second, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(server.state.tasks.map(task => task.id)).toEqual([2, 1]));
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
  fireEvent.keyDown(await slot.findByLabelText("Subject for #1"), { key: "ArrowRight", altKey: true });
  expect(server.state.tasks.find(task => task.id === 1)?.parentId).toBeUndefined();
  fireEvent.keyDown(await slot.findByLabelText("Subject for #1"), { key: "]", ...mod });
  await waitFor(() => expect(server.state.tasks.find(task => task.id === 1)?.parentId).toBe(2));
  await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Subject for #1"));
  fireEvent.keyDown(await slot.findByLabelText("Subject for #1"), { key: "[", ...mod });
  await waitFor(() => expect(server.state.tasks.find(task => task.id === 1)?.parentId).toBeUndefined());
  slot.lifecycle.unmount();
});

it("shows a rejected edit as an alert without losing the list", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const panel = app.threadPanelActions.find(action => action.id === "todos")!;
  const slot = renderSlot(panel, { threadId: "thread-a", params: null }, { rpc: {
    snapshot: () => ({ tasks: [{ id: 1, subject: "Only", status: "pending" }], nextId: 2 }),
    mutate: () => { throw new Error("subject cannot be empty"); },
  } });
  const subject = await slot.findByLabelText("Subject for #1");
  fireEvent.change(subject, { target: { value: "Next" } });
  fireEvent.blur(subject);
  expect((await slot.findByRole("alert")).textContent).toContain("subject cannot be empty");
  fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
  expect(slot.queryByRole("alert")).toBeNull();
  expect(slot.getByLabelText("Subject for #1")).toBeTruthy();
  slot.lifecycle.unmount();
});

it("shows the completion count in the header action and opens the panel", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const header = app.threadHeaderActions.find(action => action.id === "todos")!;
  const slot = renderSlot(header, { threadId: "thread-a", projectId: "project", isCompactViewport: false }, { rpc: {
    snapshot: () => ({ tasks: [{ id: 1, subject, status: "completed" }, { id: 2, subject: "Next", status: "pending" }, { id: 3, subject: "Gone", status: "deleted" }], nextId: 4 }),
  } });
  const button = await slot.findByRole("button", { name: "Open Todos, 1 of 2 complete" });
  expect(button.textContent).toBe("1/2");
  fireEvent.click(button);
  expect(slot.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "todos" } }]);
  slot.lifecycle.unmount();
});

it("keeps the header action icon-only while the list is empty", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const header = app.threadHeaderActions.find(action => action.id === "todos")!;
  const slot = renderSlot(header, { threadId: "thread-a", projectId: "project", isCompactViewport: false }, { rpc: { snapshot: () => ({ tasks: [], nextId: 1 }) } });
  const button = await slot.findByRole("button", { name: "Open Todos" });
  expect(button.textContent).toBe("");
  slot.lifecycle.unmount();
});

it("opens the panel from the composer card's edit button", async () => {
  const slot = await mount();
  fireEvent.click(await slot.findByRole("button", { name: "Edit todos" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "todos" } }]);
  slot.lifecycle.unmount();
});

it("titles a running card with the active task's working label", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const banner = app.composerCustomizations[0]!.banners![0]!;
  const slot = renderSlot(banner, {}, {
    composer: { scope: { kind: "thread", threadId: "thread-a" }, isRunning: true },
    rpc: { snapshot: () => ({ tasks: [{ id: 1, subject, status: "in_progress", activeForm: "Planning the release" }, { id: 2, subject: "Ship", status: "pending" }], nextId: 3 }) },
  });
  const toggle = await slot.findByRole("button", { name: "Show compact todos" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(slot.getByText(subject)).toBeTruthy();
  expect(slot.container.querySelector(".todo-row-spinner")).toBeTruthy();
  slot.lifecycle.unmount();
});

it("omits the edit button in queued-message composers, which have no side panel", async () => {
  const slot = await mount();
  await slot.behavior.setComposerScope({ kind: "queued-message", threadId: "thread-a", queuedMessageId: "queue-1" });
  await slot.findByText(subject);
  expect(slot.queryByRole("button", { name: "Edit todos" })).toBeNull();
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

it("shows the next two pending tasks while collapsed, and the full list when expanded", async () => {
  const slot = await mount(() => ({ tasks: [
    { id: 1, subject: "Done", status: "completed" },
    { id: 2, subject: "Next", status: "pending" },
    { id: 3, subject: "Then", status: "pending", blockedBy: [2] },
    { id: 4, subject: "Later", status: "pending" },
  ], nextId: 5 }));
  const toggle = await slot.findByRole("button", { name: "Show all 4 todos" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(slot.getAllByRole("listitem").map(row => row.textContent)).toEqual([expect.stringContaining("Next"), expect.stringContaining("Then")]);
  expect(slot.queryByText("Later")).toBeNull();
  expect(slot.queryByText("Todos", { exact: true })).toBeNull();
  fireEvent.click(toggle);
  expect(slot.getAllByRole("listitem")).toHaveLength(4);
  fireEvent.click(slot.getByRole("button", { name: "Show compact todos" }));
  expect(slot.getAllByRole("listitem")).toHaveLength(2);
  slot.lifecycle.unmount();
});

it("keeps all active todos visible when a running card is collapsed", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const slot = renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
    composer: { scope: { kind: "thread", threadId: "thread-a" }, isRunning: true },
    rpc: { snapshot: () => ({ tasks: [
      { id: 1, subject: "First", status: "in_progress" },
      { id: 2, subject: "Second", status: "in_progress" },
      { id: 3, subject: "Third", status: "in_progress" },
      { id: 4, subject: "Waiting", status: "pending" },
    ], nextId: 5 }) },
  });
  const toggle = await slot.findByRole("button", { name: "Show compact todos" });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(slot.getAllByRole("listitem")).toHaveLength(3);
  expect(slot.container.querySelectorAll(".todo-row-spinner")).toHaveLength(3);
  expect(slot.queryByText("Waiting")).toBeNull();
  slot.lifecycle.unmount();
});

it("hides a completed card after 30 seconds by default", async () => {
  vi.useFakeTimers();
  const app = await loadPluginApp(() => import("./app.js"));
  const completed = renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
    composer: { scope: { kind: "thread", threadId: "thread-a" } },
    rpc: { snapshot: () => ({ tasks: [{ id: 1, subject, status: "completed" }], nextId: 2 }) },
  });
  await act(async () => {});
  expect(completed.getByRole("button", { name: "Show all 1 todos" })).toBeTruthy();
  expect(completed.queryByText("Plan the release")).toBeNull();
  await act(async () => { vi.advanceTimersByTime(29_999); });
  expect(completed.getByRole("button", { name: "Show all 1 todos" })).toBeTruthy();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(completed.queryByRole("button", { name: "Show all 1 todos" })).toBeNull();
  completed.lifecycle.unmount();
});

it("hides a completed card after the configured delay and shows it again when tasks change", async () => {
  let current = { tasks: [{ id: 1, subject, status: "completed" as const }], nextId: 2 };
  const slot = await mount(() => current, { completedHideDelaySeconds: 0.05 });
  await slot.findByRole("button", { name: "Show all 1 todos" });
  await waitFor(() => expect(slot.queryByRole("button", { name: "Show all 1 todos" })).toBeNull());
  current = { tasks: [{ id: 1, subject, status: "completed" as const }, { id: 2, subject: "Next task", status: "pending" as const }], nextId: 3 };
  await slot.behavior.emitRealtime("todo-changed", { threadId: "thread-a" });
  await slot.findByText("Next task");
  slot.lifecycle.unmount();
});

it("restarts the completion delay after another completed-list mutation", async () => {
  let current = { tasks: [{ id: 1, subject, status: "completed" as const }], nextId: 2 };
  const slot = await mount(() => current, { completedHideDelaySeconds: 0.15 });
  const toggle = await slot.findByRole("button", { name: "Show all 1 todos" });
  await new Promise(resolve => setTimeout(resolve, 90));
  current = { tasks: [{ id: 1, subject: "Updated completed task", status: "completed" as const }], nextId: 2 };
  await slot.behavior.emitRealtime("todo-changed", { threadId: "thread-a" });
  await new Promise(resolve => setTimeout(resolve, 90));
  expect(slot.getByRole("button", { name: "Show all 1 todos" })).toBeTruthy();
  await waitFor(() => expect(slot.queryByRole("button", { name: "Show all 1 todos" })).toBeNull());
  slot.lifecycle.unmount();
});
