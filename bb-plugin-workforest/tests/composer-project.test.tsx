// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { bootstrap, entry } from "./fixtures.js";

let app: Awaited<ReturnType<typeof loadPluginApp>>;
beforeAll(async () => {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  });
  app = await loadPluginApp(() => import("../app.js"));
});
afterEach(cleanup);
const handlers = {
  bootstrap: () => bootstrap,
  inventory: () => ({ workspaces: [], repositories: [entry] }),
  project: () => ({ projectId: "p1", path: entry.path }),
};
function mount(rpc = handlers) {
  const customization = app.composerCustomizations.find(
    (item) => item.id === "workforest-project",
  )!;
  expect(customization.scopes).toEqual(["new-thread"]);
  expect(customization.banners).toBeUndefined();
  expect(customization.actions).toBeUndefined();
  const item = customization.plusMenu![0]!;
  expect(item.label).toBe("Use Workforest checkout…");
  const state = {
    text: "Fix auth safely",
    selection: { projectId: "old", model: "current-model" } as Record<
      string,
      unknown
    >,
    selections: [] as unknown[],
  };
  const composer = {
    isSubmitting: false,
    get selection() {
      return state.selection;
    },
    async setSelection(next: Record<string, unknown>) {
      state.selection = { ...state.selection, ...next };
      state.selections.push(next);
      return state.selection;
    },
    focus() {},
  };
  const overlay = app.appOverlays.find(
    (entry) => entry.id === "workforest-project-picker",
  )!;
  const slot = renderSlot(overlay, {}, { rpc });
  return {
    slot,
    state,
    open: () => act(() => item.run({ composer, view: {} } as never)),
  };
}
describe("Composer Workforest project picker", () => {
  it("loads only on opening and selects an existing project without losing the draft", async () => {
    const { slot, state, open } = mount();
    expect(slot.inspection.rpcCalls).toHaveLength(0);
    await open();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Use project for app/fix-auth",
      }),
    );
    await waitFor(() => expect(state.selections).toHaveLength(1));
    expect(state.selection).toEqual({
      projectId: "p1",
      model: "current-model",
      environment: {
        type: "host",
        hostId: "h1",
        workspace: { type: "unmanaged", path: entry.path },
      },
    });
    expect(state.text).toBe("Fix auth safely");
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    slot.lifecycle.unmount();
  });
  it("filters checkouts and creates only when a row is selected", async () => {
    const { slot, state, open } = mount({
      ...handlers,
      bootstrap: () => ({ ...bootstrap, projects: [] }),
    });
    await open();
    await screen.findByRole("button", {
      name: "Create project for app/fix-auth",
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search Workforest checkouts" }),
      { target: { value: "missing" } },
    );
    await screen.findByText("No matching checkouts.");
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "project"),
    ).toBe(false);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search Workforest checkouts" }),
      { target: { value: "/work/app" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create project for app/fix-auth" }),
    );
    await waitFor(() => expect(state.selection?.projectId).toBe("p1"));
    expect(
      slot.inspection.rpcCalls.find((call) => call.method === "project")?.input,
    ).toEqual({ hostId: "h1", selector: entry.selector });
    slot.lifecycle.unmount();
  });
  it("keeps the popup, draft, and selection on registration failure and allows retry", async () => {
    let fails = true;
    const { slot, state, open } = mount({
      ...handlers,
      project: () => {
        if (fails) throw new Error("Checkout disappeared");
        return handlers.project();
      },
    });
    await open();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Use project for app/fix-auth",
      }),
    );
    await screen.findByText("Checkout disappeared");
    expect(state.selection?.projectId).toBe("old");
    expect(state.text).toBe("Fix auth safely");
    fails = false;
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Use project for app/fix-auth",
      }),
    );
    await waitFor(() => expect(state.selection?.projectId).toBe("p1"));
    slot.lifecycle.unmount();
  });
  it("shows machine inventory errors without creating a project", async () => {
    const { slot, state, open } = mount({
      ...handlers,
      inventory: () => {
        throw new Error("Install wf on this machine");
      },
    });
    await open();
    await screen.findByText("Install wf on this machine");
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "project"),
    ).toBe(false);
    slot.lifecycle.unmount();
  });
});
