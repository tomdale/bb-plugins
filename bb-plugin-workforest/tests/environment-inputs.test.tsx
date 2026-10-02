// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { bootstrap, entry } from "./fixtures.js";

let app: Awaited<ReturnType<typeof loadPluginApp>>;
beforeAll(async () => {
  app = await loadPluginApp(() => import("../app.js"));
});
afterEach(cleanup);
const workspace = {
  ...entry,
  type: "template-workspace",
  repos: ["web", "api"],
};
function mount(
  overrides: Record<string, (input: any) => any> = {},
  props: Record<string, any> = {},
) {
  const changes: any[] = [];
  const slot = renderSlot(
    app.environmentProviderInputs[0]!,
    {
      projectId: "p1",
      target: { kind: "existing-host", hostId: "h1" },
      value: null,
      onChange: (next: any) => changes.push(next),
      ...props,
    },
    {
      rpc: {
        bootstrap: () => bootstrap,
        inventory: () => ({ workspaces: [workspace], repositories: [] }),
        templates: () => [],
        ...overrides,
      },
    },
  );
  return { slot, changes };
}
describe("Workforest environment inputs", () => {
  it("automatically resolves the selected project's workspace root and reports ready inputs", async () => {
    const { slot, changes } = mount();
    await slot.findByText("Coordinator · 2 repos");
    expect(slot.queryByLabelText("Workforest mode")).toBeNull();
    fireEvent.click(
      slot.getByRole("button", { name: "Workforest checkout settings" }),
    );
    await screen.findByText(
      "Workspace coordinator · 2 repositories · no root Git branch",
    );
    await waitFor(() =>
      expect(changes.at(-1)).toEqual({
        status: "ready",
        value: { mode: "existing", selector: entry.selector, path: entry.path },
      }),
    );
    expect(
      (screen.getByLabelText("Workforest mode") as HTMLSelectElement).value,
    ).toBe("existing");
    expect(slot.queryByText("Unknown checkout")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Workforest mode")).toBeNull(),
    );
    expect(
      slot
        .getByRole("button", { name: "Workforest checkout settings" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });
  it("blocks loading errors and permits retry", async () => {
    let fail = true;
    const { slot, changes } = mount({
      inventory: () => {
        if (fail) throw new Error("offline");
        return { workspaces: [workspace], repositories: [] };
      },
    });
    await slot.findByText("offline");
    expect(changes.at(-1)).toEqual({ status: "blocked", reason: "offline" });
    fail = false;
    fireEvent.click(
      slot.getByRole("button", { name: "Retry Workforest loading" }),
    );
    await slot.findByText("Coordinator · 2 repos");
    await waitFor(() => expect(changes.at(-1).status).toBe("ready"));
  });
  it("does not auto-select another machine's matching path", async () => {
    const { slot, changes } = mount(
      {},
      { target: { kind: "existing-host", hostId: "h2" } },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Workforest checkout settings" }),
    );
    await screen.findByLabelText("Workspace name");
    expect(changes.at(-1).status).toBe("blocked");
  });
  it("does not treat a member project as a workspace-root match", async () => {
    const { slot } = mount({
      bootstrap: () => ({
        ...bootstrap,
        projects: [
          {
            ...bootstrap.projects[0],
            sources: [{ hostId: "h1", path: `${entry.path}/api` }],
          },
        ],
      }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Workforest checkout settings" }),
    );
    await screen.findByLabelText("Workspace name");
  });
  it("retains valid saved input when no workspace project matches", async () => {
    const { slot, changes } = mount(
      {},
      {
        projectId: "other",
        value: { mode: "existing", selector: entry.selector, path: entry.path },
      },
    );
    await slot.findByText("Coordinator · 2 repos");
    await waitFor(() => expect(changes.at(-1).status).toBe("ready"));
  });
  it("allows switching from an auto-selected root to new-workspace creation", async () => {
    const { slot, changes } = mount();
    await slot.findByText("Coordinator · 2 repos");
    fireEvent.click(
      slot.getByRole("button", { name: "Workforest checkout settings" }),
    );
    fireEvent.change(screen.getByLabelText("Workforest mode"), {
      target: { value: "new" },
    });
    fireEvent.change(screen.getByLabelText("Workforest source"), {
      target: { value: "@example" },
    });
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "fix-auth" },
    });
    await waitFor(() =>
      expect(changes.at(-1)).toEqual({
        status: "ready",
        value: { mode: "new", source: "@example", name: "fix-auth" },
      }),
    );
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "BAD NAME" },
    });
    await waitFor(() => expect(changes.at(-1).status).toBe("blocked"));
  });
  it("blocks new-machine selection rather than using stale inventory", async () => {
    const { slot, changes } = mount({}, { target: { kind: "new-host" } });
    await slot.findByText("Choose a connected machine to use Workforest.");
    expect(changes.at(-1).status).toBe("blocked");
    expect(slot.inspection.rpcCalls).toHaveLength(0);
  });
});
