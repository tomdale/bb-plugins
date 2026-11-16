// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DEFAULT_RING_ACTIONS, RING_ACTION_LIMIT, type RingAction } from "./ring-actions";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const app = await loadPluginApp(() => import("./app"));

const REGISTRATIONS = [
  { key: "bb--core/split", pluginId: "bb--core", title: "Open in split", icon: "Columns2" },
  { key: "bb--core/copyLink", pluginId: "bb--core", title: "Copy link", icon: "Copy" },
  { key: "bb--core/read", pluginId: "bb--core", title: "Mark read / unread", icon: "MailOpen" },
  { key: "bb--core/pin", pluginId: "bb--core", title: "Pin", icon: "Pin" },
  { key: "bb--core/rename", pluginId: "bb--core", title: "Rename", icon: "Edit" },
  { key: "bb--core/archive", pluginId: "bb--core", title: "Archive", icon: "Archive" },
  { key: "bb--core/delete", pluginId: "bb--core", title: "Delete", icon: "Trash2" },
  { key: "workstreams/snooze", pluginId: "workstreams", title: "Snooze", icon: "Clock" },
  { key: "thread-list/move", pluginId: "thread-list", title: "Move to section", icon: "SectionMove" },
  { key: "burn/cost", pluginId: "burn", title: "Cost", icon: "Flame" },
  { key: "push-notifications/notifications", pluginId: "push-notifications", title: "Notifications", icon: "Bell" },
];
const SNOOZE: RingAction = { key: "workstreams/snooze", title: "Snooze", icon: "Clock" };

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderSettings({
  ring = null as RingAction[] | null,
  registrations = REGISTRATIONS,
  hold = false,
} = {}) {
  const stored = { ring };
  let release: (() => void) | null = null;
  const section = app.settingsSections.find((entry) => entry.id === "actions")!;
  const slot = renderSlot(section, {}, {
    threadActionRegistrations: registrations,
    sdk: {
      plugins: {
        // Only the fields the section reads.
        list: (async () => ({
          plugins: [
            { id: "workstreams", name: "Workstreams" },
            { id: "thread-list", name: "Thread list" },
            { id: "burn", name: "Burn" },
            { id: "push-notifications", name: "Push notifications" },
          ],
        })) as never,
      },
    },
    rpc: {
      ringActions: async () => {
        if (hold) await new Promise<void>((resolve) => (release = resolve));
        return { actions: stored.ring };
      },
      setRingActions: async (input: unknown) => {
        const { actions } = input as { actions: RingAction[] | null };
        stored.ring = actions;
        return { actions };
      },
    },
  });
  if (!hold) await slot.findByRole("list", { name: "Ring actions, clockwise from the top" });
  if (!hold) await waitFor(() => expect(slot.getByRole("button", { name: "Add action" })).toBeEnabled());
  const rows = () =>
    within(slot.getByRole("list", { name: "Ring actions, clockwise from the top" }))
      .getAllByRole("listitem")
      .map((row) => row.textContent);
  const saves = () =>
    slot.inspection.rpcCalls
      .filter((call) => call.method === "setRingActions")
      .map((call) => (call.input as { actions: RingAction[] | null }).actions);
  return { slot, stored, rows, saves, release: () => release?.() };
}

describe("Actions settings", () => {
  it("registers under the title Actions", () => {
    expect(app.settingsSections.map((entry) => [entry.id, entry.title])).toContainEqual([
      "actions",
      "Actions",
    ]);
  });

  it("lists the ring in order, naming plugin owners, beside a preview of the ring", async () => {
    const { slot, rows } = await renderSettings({
      ring: [DEFAULT_RING_ACTIONS[0]!, SNOOZE, ...DEFAULT_RING_ACTIONS.slice(1)],
    });
    expect(rows()).toEqual(["Archive", "SnoozeWorkstreams", "Pin", "Mark read / unread", "Copy link"]);
    expect(
      Array.from(document.querySelectorAll(".qa-actions-preview-item")).map((node) => node.textContent),
    ).toEqual(["Archive", "Snooze", "Pin", "Mark read / unread", "Copy link"]);
    slot.lifecycle.unmount();
  });

  it("adds an action from the menu to the end of the ring", async () => {
    const user = userEvent.setup();
    const { slot, saves, rows } = await renderSettings();
    await user.click(slot.getByRole("button", { name: "Add action" }));
    const menu = await slot.findByRole("menu");
    // Actions already in the ring aren't offered again.
    expect(within(menu).queryByRole("menuitem", { name: "Archive" })).toBeNull();
    expect(within(menu).getByText("Workstreams")).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Snooze" }));
    await waitFor(() => expect(saves()).toEqual([[...DEFAULT_RING_ACTIONS, SNOOZE]]));
    expect(rows().at(-1)).toBe("SnoozeWorkstreams");
    slot.lifecycle.unmount();
  });

  it("removes an action, but never the last one", async () => {
    const user = userEvent.setup();
    const { slot, saves } = await renderSettings({ ring: [DEFAULT_RING_ACTIONS[0]!, SNOOZE] });
    await user.click(slot.getByRole("button", { name: "Remove Snooze" }));
    await waitFor(() => expect(saves()).toEqual([[DEFAULT_RING_ACTIONS[0]]]));
    expect(slot.getByRole("button", { name: "Remove Archive" })).toBeDisabled();
    slot.lifecycle.unmount();
  });

  it("moves an action with the arrow keys and keeps focus on it", async () => {
    const user = userEvent.setup();
    const { slot, saves, rows } = await renderSettings();
    await act(async () => slot.getByRole("button", { name: "Move Archive" }).focus());
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(rows()).toEqual(["Pin", "Archive", "Mark read / unread", "Copy link"]),
    );
    expect(slot.getByRole("button", { name: "Move Archive" })).toHaveFocus();
    expect(saves()[0]!.map((action) => action.key)).toEqual([
      "bb--core/pin",
      "bb--core/archive",
      "bb--core/read",
      "bb--core/copyLink",
    ]);
    slot.lifecycle.unmount();
  });

  it("keeps an action whose plugin is gone, marked unavailable", async () => {
    const { slot, rows } = await renderSettings({
      ring: [...DEFAULT_RING_ACTIONS, { key: "gone/triage", title: "Triage", icon: "Inbox" }],
    });
    expect(rows().at(-1)).toBe("TriageUnavailable");
    expect(slot.getByRole("button", { name: "Remove Triage" })).toBeEnabled();
    slot.lifecycle.unmount();
  });

  it("offers nothing more once the ring is full", async () => {
    const user = userEvent.setup();
    const ring = REGISTRATIONS.slice(0, RING_ACTION_LIMIT).map(({ key, title, icon }) => ({ key, title, icon }));
    const { slot } = await renderSettings({ ring });
    await user.click(slot.getByRole("button", { name: "Add action" }));
    const menu = await slot.findByRole("menu");
    expect(within(menu).getByText("The ring is full.")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Notifications" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    slot.lifecycle.unmount();
  });

  it("resets to the default only after a change", async () => {
    const user = userEvent.setup();
    const first = await renderSettings();
    expect(first.slot.queryByRole("button", { name: "Reset to default" })).toBeNull();
    first.slot.lifecycle.unmount();

    const { slot, saves } = await renderSettings({ ring: [SNOOZE] });
    await user.click(slot.getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(saves()).toEqual([null]));
    slot.lifecycle.unmount();
  });

  it("changes nothing until the saved ring loads", async () => {
    const { slot, saves, release } = await renderSettings({ hold: true, ring: [SNOOZE] });
    await slot.findByRole("list", { name: "Ring actions, clockwise from the top" });
    expect(slot.getByRole("button", { name: "Add action" })).toBeDisabled();
    expect(slot.getByRole("button", { name: "Move Archive" })).toBeDisabled();
    await act(async () => release());
    await waitFor(() => expect(slot.getByRole("button", { name: "Move Snooze" })).toBeEnabled());
    expect(saves()).toEqual([]);
    slot.lifecycle.unmount();
  });
});
