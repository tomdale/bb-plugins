// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { bootstrap, detail, entry } from "./fixtures.js";

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
  jobs: () => [],
  detail: () => detail,
  templates: () => [],
};
describe("Workforest UI", () => {
  it("registers additive navigation, header, homepage, and thread panel slots", () => {
    expect(app.navPanels).toHaveLength(1);
    expect(app.threadPanelActions).toHaveLength(1);
  });
  it("renders live inventory and navigates via a stable deep link", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "h1" },
      { rpc: handlers },
    );
    fireEvent.click(await slot.findByRole("button", { name: /fix-auth/ }));
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain(
      "h1/app/fix-auth",
    );
    slot.lifecycle.unmount();
  });
  it("search filters inventory without mutating Workforest", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "h1" },
      { rpc: handlers },
    );
    await slot.findByRole("button", { name: /fix-auth/ });
    fireEvent.change(slot.getByRole("textbox", { name: "Search Workforest" }), {
      target: { value: "missing" },
    });
    await slot.findByText("No matching checkouts.");
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "start"),
    ).toBe(false);
    slot.lifecycle.unmount();
  });
  it("shows the full Workforest checkout identity in the thread header", async () => {
    const slot = renderSlot(
      app.threadHeaderActions[0]!,
      { threadId: "t1", projectId: "p1", isCompactViewport: false },
      { rpc: { context: () => ({ hostId: "h1", entry, path: entry.path }) } },
    );
    const header = await slot.findByRole("button", {
      name: `Open Workforest workspace ${entry.selector}`,
    });
    expect(header.textContent).toContain(entry.selector);
    expect(header.querySelector("span[title]")?.getAttribute("title")).toBe(
      entry.selector,
    );
    slot.lifecycle.unmount();
  });
  it("shows repository status and a non-destructive cleanup preview action", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "h1/app/fix-auth" },
      { rpc: handlers },
    );
    await slot.findByText("feature/fix-auth");
    expect(slot.getByRole("button", { name: "Thread in app" })).toBeTruthy();
    expect(
      slot.getByRole("button", { name: "Check cleanup safety" }),
    ).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("creates checkout operations only after form submission", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "h1" },
      {
        rpc: {
          ...handlers,
          start: () => ({
            id: "j1",
            label: "Create",
            state: "running",
            output: "",
            startedAt: 0,
            finishedAt: null,
          }),
        },
      },
    );
    await slot.findByRole("button", { name: /fix-auth/ });
    fireEvent.click(slot.getByRole("button", { name: "New workspace" }));
    fireEvent.change(await screen.findByLabelText("Change name"), {
      target: { value: "new-feature" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^Repositories/ }), {
      target: { value: "owner/app" },
    });
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "start"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Create checkout" }));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some((call) => call.method === "start"),
      ).toBe(true),
    );
    expect(JSON.stringify(slot.inspection.rpcCalls)).toContain("new-feature");
    slot.lifecycle.unmount();
  });
  it("groups dense previews, expands older work, and reveals every search match", async () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      ...entry,
      selector: `app/change-${index}`,
      changeName: `change-${index}`,
      modifiedAtMs: 1000 - index,
    }));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "h1" },
      {
        rpc: {
          ...handlers,
          inventory: () => ({ workspaces: [], repositories: entries }),
        },
      },
    );
    await slot.findByRole("button", { name: "Open app/change-0" });
    expect(
      slot.queryByRole("button", { name: "Open app/change-7" }),
    ).toBeNull();
    expect(slot.queryByText("Select a checkout to see branches")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Show 3 more in app" }));
    expect(
      slot.getByRole("button", { name: "Open app/change-7" }),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Show fewer in app" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Search Workforest" }), {
      target: { value: "change-" },
    });
    expect(
      slot.getByRole("button", { name: "Open app/change-7" }),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Collapse app" }));
    expect(
      slot.queryByRole("button", { name: "Open app/change-7" }),
    ).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Expand app" }));
    expect(
      slot.getByRole("button", { name: "Open app/change-7" }),
    ).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("filters needs-attention entries without mistaking ready checkouts for dirty Git state", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "h1" },
      {
        rpc: {
          ...handlers,
          inventory: () => ({
            workspaces: [],
            repositories: [
              entry,
              {
                ...entry,
                selector: "app/stale",
                changeName: "stale",
                state: "stale",
              },
            ],
          }),
        },
      },
    );
    await slot.findByRole("button", { name: "Open app/fix-auth" });
    fireEvent.click(slot.getByRole("button", { name: /Needs attention/ }));
    expect(
      slot.queryByRole("button", { name: "Open app/fix-auth" }),
    ).toBeNull();
    expect(slot.getByRole("button", { name: "Open app/stale" })).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("renders machine failures as actionable errors", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "h1" },
      {
        rpc: {
          ...handlers,
          inventory: () => {
            throw new Error("Install wf on this machine");
          },
        },
      },
    );
    await slot.findByText(/Install wf/);
    slot.lifecycle.unmount();
  });
});
