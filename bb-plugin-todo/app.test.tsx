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
    rpc: { snapshot, archiveCompleted: () => ({ archived: true }) },
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
  expect(slot.container.querySelectorAll(".todo-editor-marker:not(.todo-editor-marker-unordered)")).toHaveLength(3);
  expect(slot.container.querySelector(".todo-editor-number:not(.todo-editor-number-active)")?.textContent).toBe("1.");
  expect(slot.container.querySelectorAll(".todo-editor-number-active .todo-editor-spokes i")).toHaveLength(8);
  expect(slot.container.querySelector(".todo-editor-period")?.previousSibling?.textContent).toBe("1");
  expect(slot.container.querySelector(".todo-editor-marker-unordered")).toBeNull();
  expect(slot.getByTitle("Depends on 3. Prerequisite").textContent).toContain("depends on 3");
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
  expect(slot.container.querySelectorAll(".todo-editor-marker-unordered")).toHaveLength(2);
  expect(slot.container.querySelector(".todo-editor-number")).toBeNull();
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
    rpc: { snapshot: () => ({ tasks: [{ id: 1, subject, status: "in_progress", activeForm: "Planning the release" }, { id: 2, subject: "Ship", status: "pending", blockedBy: [1] }], nextId: 3 }) },
  });
  const toggle = await slot.findByRole("button", { name: "Show all 2 todos" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(slot.getByText("Planning the release")).toBeTruthy();
  expect(slot.container.querySelectorAll(".todo-row-marker-ordered .todo-row-number-active .todo-spokes i")).toHaveLength(8);
  const spinner = slot.container.querySelector(".todo-row-marker-ordered .todo-row-number-active .todo-row-spinner");
  expect(spinner?.classList.contains("todo-row-spinner")).toBe(true);
  expect(spinner?.querySelector(".todo-spokes")).toBeTruthy();
  expect(slot.container.querySelector(".todo-row-marker-ordered .todo-row-period")).toBeNull();
  expect(slot.container.querySelector(".todo-row-marker-ordered .todo-row-number-active")).toBeTruthy();
  slot.lifecycle.unmount();
});

it("omits the edit button in queued-message composers, which have no side panel", async () => {
  const slot = await mount();
  await slot.behavior.setComposerScope({ kind: "queued-message", threadId: "thread-a", queuedMessageId: "queue-1" });
  await slot.findByText("0 of 1 todos done");
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
  await waitFor(() => expect(document.querySelector(".todo-card")?.getAttribute("data-floating")).toBe(""));
  const lane = document.querySelector<HTMLElement>(".todo-card")!;
  expect(lane.style.left).toBe("712px");
  // Its vertical position is constant, so scrolling never moves it against the page.
  expect(lane.style.top).toBe("16px");
  slot.lifecycle.unmount();
});

it("stays in the gutter, at the same place, while no message column is on screen", async () => {
  const slot = await mount(idleSnapshot, {}, true);
  const column = document.querySelector<HTMLElement>("[data-message-column]")!;
  const scrollArea = column.parentElement!;
  await waitFor(() => expect(document.querySelector(".todo-card")?.getAttribute("data-floating")).toBe(""));
  const before = document.querySelector<HTMLElement>(".todo-card")!.style.left;
  column.getBoundingClientRect = () => ({ x: 0, y: 2000, left: 0, right: 700, top: 2000, bottom: 2200, width: 700, height: 200, toJSON: () => ({}) } as DOMRect);
  fireEvent.scroll(scrollArea);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(document.querySelector(".todo-card")?.getAttribute("data-floating")).toBe("");
  expect(document.querySelector<HTMLElement>(".todo-card")!.style.left).toBe(before);
  slot.lifecycle.unmount();
});

it("measures the gutter from the inset prose column even when a user-message column is the last one visible", async () => {
  const slot = await mount(idleSnapshot, {}, true);
  const userColumn = document.querySelector<HTMLElement>("[data-message-column]")!;
  const scrollArea = userColumn.parentElement!;
  const proseColumn = document.createElement("div");
  proseColumn.setAttribute("data-message-column", "");
  proseColumn.style.paddingLeft = "8px";
  proseColumn.style.paddingRight = "8px";
  Object.defineProperty(proseColumn, "clientWidth", { value: 700 });
  proseColumn.getBoundingClientRect = () => ({ x: 0, y: 100, left: 0, right: 700, top: 100, bottom: 250, width: 700, height: 150, toJSON: () => ({}) } as DOMRect);
  scrollArea.insertBefore(proseColumn, userColumn);
  fireEvent.scroll(scrollArea);
  await waitFor(() => expect(document.querySelector<HTMLElement>(".todo-card")?.style.left).toBe("704px"));
  slot.lifecycle.unmount();
});

it("shows the gutter lane as the full list with only a Todos link as its control", async () => {
  const slot = await mount(
    () => ({ tasks: [{ id: 1, subject: "Plan the release", status: "completed" }, { id: 2, subject, status: "pending" }], nextId: 3 }),
    {},
    true,
  );
  await waitFor(() => expect(document.querySelector(".todo-card")?.getAttribute("data-floating")).toBe(""));
  const lane = document.querySelector<HTMLElement>(".todo-card")!;
  expect(lane.getAttribute("data-state")).toBe("expanded");
  expect(within(lane).getAllByRole("listitem")).toHaveLength(2);
  expect(lane.querySelector(".todo-count")).toBeNull();
  expect(lane.querySelector(".todo-view-toggle")).toBeNull();
  expect(lane.querySelector(".todo-edit")).toBeNull();
  expect(within(lane).getAllByRole("button")).toHaveLength(1);
  // Clicking the lane's rows must not collapse it, and the link opens the Todos panel.
  fireEvent.click(within(lane).getAllByRole("listitem")[0]!);
  expect(lane.getAttribute("data-state")).toBe("expanded");
  fireEvent.click(within(lane).getByRole("button", { name: "Open Todos panel" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "todos" } }]);
  slot.lifecycle.unmount();
});

it("keeps queued-message cards in their own composer instead of claiming the thread gutter", async () => {
  const slot = await mount(idleSnapshot, {}, true);
  await slot.behavior.setComposerScope({ kind: "queued-message", threadId: "thread-a", queuedMessageId: "queue-1" });
  await slot.findByText("0 of 1 todos done");
  await waitFor(() => expect(document.querySelector(".todo-card")?.getAttribute("data-floating")).toBeNull());
  slot.lifecycle.unmount();
});

it("keeps the card in the composer when no measurable side gutter is available", async () => {
  const slot = await mount();
  const card = await slot.findByText("0 of 1 todos done");
  expect(card.closest(".todo-card")?.getAttribute("data-floating")).toBeNull();
  slot.lifecycle.unmount();
});

it("announces a stale in-progress snapshot as pending while idle", async () => {
  const slot = await mount(() => ({ tasks: [{ id: 1, subject, status: "in_progress" as const }], nextId: 2 }));
  const summary = await slot.findByText("0 of 1 todos done");
  expect(summary).toBeTruthy();
  expect(slot.container.querySelector("svg[data-progress]")).toBeTruthy();
  slot.lifecycle.unmount();
});

it("prints 'X of Y todos done' with circle progress indicator when no tasks are in progress", async () => {
  const slot = await mount(() => ({ tasks: [
    { id: 1, subject: "Done", status: "completed" },
    { id: 2, subject: "Next", status: "pending" },
    { id: 3, subject: "Then", status: "pending", blockedBy: [2] },
    { id: 4, subject: "Later", status: "pending" },
  ], nextId: 5 }));
  const toggle = await slot.findByRole("button", { name: "Show all 4 todos" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(slot.getByText("1 of 4 todos done")).toBeTruthy();
  expect(slot.container.querySelector("svg[data-progress]")).toBeTruthy();
  // Entire card in collapsed state is clickable to expand
  fireEvent.click(slot.container.querySelector(".todo-card")!);
  expect(slot.getAllByRole("listitem")).toHaveLength(4);
  expect(slot.getByText("Next")).toBeTruthy();
  expect(slot.getByText("Later")).toBeTruthy();
  expect(slot.getByTitle("Depends on 2. Next").textContent).toContain("depends on 2");
  expect(slot.container.querySelector(".todo-row-number")?.textContent).toBe("1.");
  expect(slot.container.querySelector(".todo-row-period")?.previousSibling?.textContent).toBe("1");
  expect(slot.container.querySelectorAll(".todo-row-marker-ordered")).toHaveLength(4);
  expect(slot.container.querySelectorAll(".todo-row-icon")).toHaveLength(0);
  expect(slot.container.querySelector(".todo-row-marker-ordered")?.classList.contains("todo-row-marker-ordered")).toBe(true);
  const completedMarker = slot.container.querySelector(".todo-row-completed .todo-row-marker")!;
  expect(completedMarker.classList.contains("todo-row-marker-ordered")).toBe(true);
  expect(getComputedStyle(completedMarker).textDecorationLine).not.toContain("line-through");
  expect(slot.container.querySelector(".todo-row-completed .todo-row-text")?.textContent).toContain("Done");
  expect(slot.container.querySelector(".todo-row-completed .todo-row-text")?.classList.contains("todo-row-text")).toBe(true);
  // In expanded state, toggle button collapses it back
  fireEvent.click(slot.getByRole("button", { name: "Show compact todos" }));
  expect(slot.getByText("1 of 4 todos done")).toBeTruthy();
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
  const toggle = await slot.findByRole("button", { name: "Show all 4 todos" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(slot.getAllByRole("listitem")).toHaveLength(3);
  expect(slot.container.querySelectorAll(".todo-row-marker-unordered")).toHaveLength(3);
  expect(slot.container.querySelectorAll(".todo-row-status-icon")).toHaveLength(3);
  expect(slot.container.querySelector(".todo-row-marker-unordered")?.classList.contains("todo-row-marker-unordered")).toBe(true);
  expect(slot.container.querySelector(".todo-row-number")).toBeNull();
  expect(slot.container.querySelectorAll(".todo-row-icon")).toHaveLength(0);
  expect(slot.container.querySelectorAll(".todo-row-marker")).toHaveLength(3);
  expect(slot.queryByText("Waiting")).toBeNull();
  fireEvent.click(toggle);
  expect(slot.getAllByRole("listitem")).toHaveLength(4);
  expect(slot.getByText("Waiting")).toBeTruthy();
  expect(slot.container.querySelectorAll(".todo-row-marker-unordered")).toHaveLength(4);
  expect(slot.container.querySelector(".todo-row-number")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Show compact todos" }));
  expect(slot.getAllByRole("listitem")).toHaveLength(3);
  slot.lifecycle.unmount();
});

it("states all todos complete with simple copy and hides after 30 seconds by default", async () => {
  vi.useFakeTimers();
  const app = await loadPluginApp(() => import("./app.js"));
  const completed = renderSlot(app.composerCustomizations[0]!.banners![0]!, {}, {
    composer: { scope: { kind: "thread", threadId: "thread-a" } },
    rpc: { snapshot: () => ({ tasks: [{ id: 1, subject, status: "completed" }], nextId: 2 }), archiveCompleted: () => ({ archived: true }) },
  });
  await act(async () => {});
  expect(completed.getByText("All todos complete")).toBeTruthy();
  expect(completed.getByRole("button", { name: "Show all 1 todos" })).toBeTruthy();
  // Entire card in collapsed state is clickable to expand
  fireEvent.click(completed.container.querySelector(".todo-card")!);
  expect(completed.getByText(subject)).toBeTruthy();
  expect(completed.getByRole("button", { name: "Show compact todos" })).toBeTruthy();
  // Collapse it back
  fireEvent.click(completed.getByRole("button", { name: "Show compact todos" }));
  expect(completed.getByText("All todos complete")).toBeTruthy();

  await act(async () => { vi.advanceTimersByTime(29_999); });
  expect(completed.getByText("All todos complete")).toBeTruthy();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(completed.queryByText("All todos complete")).toBeNull();
  completed.lifecycle.unmount();
});

it("toggles back and forth between collapsed and expanded states at any time", async () => {
  const slot = await mount(() => ({ tasks: [
    { id: 1, subject: "Done", status: "completed" },
    { id: 2, subject: "Next", status: "pending" },
    { id: 3, subject: "Upcoming", status: "pending" },
    { id: 4, subject: "Later", status: "pending" },
  ], nextId: 5 }));
  // Initially collapsed: shows 1 of 4 todos done
  expect(slot.getByText("1 of 4 todos done")).toBeTruthy();
  const toggle = await slot.findByRole("button", { name: "Show all 4 todos" });

  // Expansion changes list content while the shared content frame animates height.
  fireEvent.click(toggle);
  expect(slot.getAllByRole("listitem")).toHaveLength(4);
  expect(slot.getByText("Done")).toBeTruthy();
  expect(slot.getByText("Later")).toBeTruthy();

  // Collapse immediately, while expansion is still transitioning.
  fireEvent.click(slot.getByRole("button", { name: "Show compact todos" }));
  expect(slot.getByText("1 of 4 todos done")).toBeTruthy();
  expect(slot.container.querySelector(".todo-card-content[data-transitioning]")).toBeTruthy();

  // Expand again by clicking the card
  fireEvent.click(slot.container.querySelector(".todo-card")!);
  expect(slot.getAllByRole("listitem")).toHaveLength(4);

  // Collapse again
  fireEvent.click(slot.getByRole("button", { name: "Show compact todos" }));
  expect(slot.getByText("1 of 4 todos done")).toBeTruthy();
  slot.lifecycle.unmount();
});

it("cancels each finished height animation so collapse measures the compact height", async () => {
  const slot = await mount(() => ({ tasks: [
    { id: 1, subject: "First task", status: "pending" },
    { id: 2, subject: "Second task", status: "pending" },
  ], nextId: 3 }));
  const originalAnimate = Element.prototype.animate;
  const frames: Keyframe[][] = [];
  let cancelled = 0;
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value(keyframes: Keyframe[]) {
      frames.push(keyframes);
      return { finished: Promise.resolve(), cancel() { cancelled += 1; } } as unknown as Animation;
    },
  });
  const content = slot.container.querySelector<HTMLElement>(".todo-card-content")!;
  content.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, right: 300, width: 300,
    top: 0, bottom: slot.container.querySelector(".todo-card")?.getAttribute("data-state") === "expanded" ? 82 : 32,
    height: slot.container.querySelector(".todo-card")?.getAttribute("data-state") === "expanded" ? 82 : 32,
    toJSON: () => ({}),
  } as DOMRect);
  try {
    fireEvent.click(slot.getByRole("button", { name: "Show all 2 todos" }));
    await waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]?.[0]?.height).toBe("32px");
    expect(frames[0]?.[1]?.height).toBe("82px");
    await waitFor(() => expect(cancelled).toBe(1));

    fireEvent.click(slot.getByRole("button", { name: "Show compact todos" }));
    await waitFor(() => expect(frames).toHaveLength(2));
    expect(slot.getByText("0 of 2 todos done")).toBeTruthy();
    expect(frames[1]?.[0]?.height).toBe("82px");
    expect(frames[1]?.[1]?.height).toBe("32px");
    await waitFor(() => expect(cancelled).toBe(2));
  } finally {
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: originalAnimate });
    slot.lifecycle.unmount();
  }
});

it("groups subtasks with their parent task in expanded mode", async () => {
  const slot = await mount(() => ({ tasks: [
    { id: 1, subject: "First root", status: "completed" },
    { id: 2, subject: "Parent with subtasks", status: "pending" },
    { id: 3, subject: "Child task", status: "pending", parentId: 2 },
    { id: 4, subject: "Second root", status: "pending" },
  ], nextId: 5 }));
  // Expand card
  fireEvent.click(slot.container.querySelector(".todo-card")!);
  const itemGroup = slot.container.querySelector(".todo-item-group")!;
  expect(itemGroup).toBeTruthy();
  expect(itemGroup.textContent).toContain("Parent with subtasks");
  expect(itemGroup.textContent).toContain("Child task");
  const subtasksList = itemGroup.querySelector(".todo-subtasks")!;
  expect(subtasksList).toBeTruthy();
  expect(subtasksList.textContent).toContain("Child task");
  slot.lifecycle.unmount();
});

it("collapses the card when clicking anywhere non-interactive while expanded", async () => {
  const slot = await mount(() => ({ tasks: [
    { id: 1, subject: "First task", status: "pending" },
    { id: 2, subject: "Second task", status: "pending" },
  ], nextId: 3 }));
  // Initially collapsed
  expect(slot.getByText("0 of 2 todos done")).toBeTruthy();

  // Click card to expand
  fireEvent.click(slot.container.querySelector(".todo-card")!);
  expect(slot.getAllByRole("listitem")).toHaveLength(2);

  // Click on a todo row to collapse, then immediately reopen and close again.
  fireEvent.click(slot.getByText("First task"));
  expect(slot.getByText("0 of 2 todos done")).toBeTruthy();
  fireEvent.click(slot.container.querySelector(".todo-card")!);
  expect(slot.getAllByRole("listitem")).toHaveLength(2);
  fireEvent.click(slot.getByText("First task"));
  expect(slot.getByText("0 of 2 todos done")).toBeTruthy();

  // Click card to expand again
  fireEvent.click(slot.container.querySelector(".todo-card")!);
  expect(slot.getAllByRole("listitem")).toHaveLength(2);

  // Click on card background to collapse
  fireEvent.click(slot.container.querySelector(".todo-card")!);
  expect(slot.getByText("0 of 2 todos done")).toBeTruthy();

  slot.lifecycle.unmount();
});

it("uses two columns only after the expanded list reaches its max height", async () => {
  const slot = await mount(() => ({ tasks: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, subject: `Task ${i + 1}`, status: "pending" as const })), nextId: 11 }));
  fireEvent.click(slot.container.querySelector(".todo-card")!);
  const list = slot.container.querySelector<HTMLUListElement>(".todo-list")!;
  expect(list.classList.contains("todo-list-two-columns")).toBe(false);

  list.style.maxHeight = "100px";
  Object.defineProperty(list, "clientHeight", { configurable: true, value: 50 });
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 100 });
  fireEvent.scroll(list);
  expect(list.classList.contains("todo-list-two-columns")).toBe(false);

  Object.defineProperty(list, "clientHeight", { configurable: true, value: 100 });
  fireEvent.scroll(list);
  await waitFor(() => expect(list.classList.contains("todo-list-two-columns")).toBe(true));
  expect(list.style.gridAutoFlow).toBe("column");
  expect(list.style.gridTemplateRows).toBe("repeat(5, auto)");

  fireEvent.click(slot.getByRole("button", { name: "Show compact todos" }));
  fireEvent.click(slot.getByRole("button", { name: "Show all 10 todos" }));
  expect(slot.container.querySelector(".todo-list")?.classList.contains("todo-list-two-columns")).toBe(false);
  slot.lifecycle.unmount();
});

it("renders top and bottom scroll fade gradients based on scroll state when scrolling is needed", async () => {
  const slot = await mount(() => ({ tasks: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, subject: `Task ${i + 1}`, status: "pending" as const })), nextId: 11 }));
  // Expand so the list with 10 items mounts
  fireEvent.click(slot.container.querySelector(".todo-card")!);
  const list = slot.container.querySelector<HTMLUListElement>(".todo-list")!;
  expect(list).toBeTruthy();

  // Mock scrollable dimensions: scrollHeight > clientHeight
  Object.defineProperty(list, "clientHeight", { configurable: true, value: 100 });
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 300 });
  Object.defineProperty(list, "scrollTop", { configurable: true, value: 0 });

  // At top: only bottom fade
  fireEvent.scroll(list);
  await waitFor(() => expect(slot.container.querySelector("[data-fade='bottom']")).toBeTruthy());
  expect(slot.container.querySelector("[data-fade='top']")).toBeNull();

  // Scrolled to middle: both top and bottom fade
  Object.defineProperty(list, "scrollTop", { configurable: true, value: 50 });
  fireEvent.scroll(list);
  await waitFor(() => {
    expect(slot.container.querySelector("[data-fade='top']")).toBeTruthy();
    expect(slot.container.querySelector("[data-fade='bottom']")).toBeTruthy();
  });

  // Scrolled to bottom: only top fade
  Object.defineProperty(list, "scrollTop", { configurable: true, value: 200 });
  fireEvent.scroll(list);
  await waitFor(() => {
    expect(slot.container.querySelector("[data-fade='top']")).toBeTruthy();
    expect(slot.container.querySelector("[data-fade='bottom']")).toBeNull();
  });

  slot.lifecycle.unmount();
});

it("hides a completed card after the configured delay and shows it again when tasks change", async () => {
  let current = { tasks: [{ id: 1, subject, status: "completed" as const }], nextId: 2 };
  const slot = await mount(() => current, { completedHideDelaySeconds: 0.05 });
  await slot.findByText("All todos complete");
  await waitFor(() => expect(slot.queryByText("All todos complete")).toBeNull());
  current = { tasks: [{ id: 1, subject, status: "completed" as const }, { id: 2, subject: "Next task", status: "pending" as const }], nextId: 3 };
  await slot.behavior.emitRealtime("todo-changed", { threadId: "thread-a" });
  await slot.findByText("1 of 2 todos done");
  slot.lifecycle.unmount();
});

it("restarts the completion delay after another completed-list mutation", async () => {
  let current = { tasks: [{ id: 1, subject, status: "completed" as const }], nextId: 2 };
  const slot = await mount(() => current, { completedHideDelaySeconds: 0.15 });
  await slot.findByText("All todos complete");
  await new Promise(resolve => setTimeout(resolve, 90));
  current = { tasks: [{ id: 1, subject: "Updated completed task", status: "completed" as const }], nextId: 2 };
  await slot.behavior.emitRealtime("todo-changed", { threadId: "thread-a" });
  await new Promise(resolve => setTimeout(resolve, 90));
  expect(slot.getByText("All todos complete")).toBeTruthy();
  await waitFor(() => expect(slot.queryByText("All todos complete")).toBeNull());
  slot.lifecycle.unmount();
});
