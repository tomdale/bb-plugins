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
import { bootstrap } from "./fixtures.js";
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
const source = {
  id: "template:app",
  name: "app",
  kind: "template",
  source: "@app",
  path: "/work/workspaces/app",
};
function mount(overrides: Record<string, (...args: any[]) => any> = {}) {
  const item = app.composerCustomizations[0]!.plusMenu![0]!;
  expect(item.label).toBe("Use Workforest source…");
  const state = { text: "Keep my draft", selections: [] as any[] };
  const composer = {
    isSubmitting: false,
    selection: { projectId: "old" },
    async setSelection(next: any) {
      state.selections.push(next);
      return next;
    },
    focus() {},
  };
  const slot = renderSlot(
    app.appOverlays.find((entry) => entry.id === "workforest-project-picker")!,
    {},
    {
      rpc: {
        bootstrap: () => bootstrap,
        sources: () => [source],
        sourceProject: () => ({ projectId: "source-project" }),
        ...overrides,
      },
    },
  );
  return {
    slot,
    state,
    open: () => act(() => item.run({ composer, view: {} } as never)),
  };
}
describe("Workforest source picker", () => {
  it("loads sources only on opening and selects a source without choosing an instance", async () => {
    const { slot, state, open } = mount();
    expect(slot.inspection.rpcCalls).toHaveLength(0);
    await open();
    fireEvent.click(
      await screen.findByRole("button", { name: "Use template app" }),
    );
    await waitFor(() => expect(state.selections).toHaveLength(1));
    expect(state.selections[0]).toEqual({
      projectId: "source-project",
      environment: {
        type: "provider",
        environmentProviderId: "workforest-workspace",
        machine: { type: "existing", hostId: "h1" },
        inputs: null,
      },
    });
    expect(
      slot.inspection.rpcCalls.find((call) => call.method === "sourceProject")
        ?.input,
    ).toEqual({ hostId: "h1", sourceId: "template:app" });
    expect(state.text).toBe("Keep my draft");
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "inventory"),
    ).toBe(false);
  });
  it("shows progress and disables duplicate selection while registration is pending", async () => {
    let finish!: (result: any) => void;
    const { open } = mount({
      sourceProject: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await open();
    const button = await screen.findByRole("button", {
      name: "Use template app",
    });
    fireEvent.click(button);
    await screen.findByText("Registering source project…");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      finish({ projectId: "source-project" });
    });
  });
  it("retains the draft on registration error and permits retry", async () => {
    let fail = true;
    const { state, open } = mount({
      sourceProject: () => {
        if (fail) throw new Error("offline");
        return { projectId: "source-project" };
      },
    });
    await open();
    fireEvent.click(
      await screen.findByRole("button", { name: "Use template app" }),
    );
    await screen.findByText("offline");
    expect(state.selections).toHaveLength(0);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Use template app" }));
    await waitFor(() => expect(state.selections).toHaveLength(1));
  });
  it("searches repositories and templates without registering on search", async () => {
    const { slot, open } = mount({
      sources: () => [
        source,
        {
          ...source,
          id: "repository:o/repo",
          name: "repo",
          kind: "repository",
          source: "o/repo",
        },
      ],
    });
    await open();
    await screen.findByRole("button", { name: "Use repository repo" });
    fireEvent.change(screen.getByLabelText("Search Workforest sources"), {
      target: { value: "repo" },
    });
    expect(
      screen.queryByRole("button", { name: "Use template app" }),
    ).toBeNull();
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "sourceProject"),
    ).toBe(false);
  });
});
