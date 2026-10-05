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
        projectSource: () => null,
        projectSources: () => [],
        ...overrides,
      },
    },
  );
  return { slot, changes };
}
describe("Workforest environment inputs", () => {
  it("filters environments by source and requires explicit instance selection", async () => {
    const source = {
      id: "template:app",
      kind: "template",
      name: "app",
      source: "@app",
      path: "/work/workspaces/app",
    };
    const { slot, changes } = mount({
      projectSource: () => source,
      projectSources: () => [source],
      sources: () => [source],
      inventory: () => ({
        workspaces: [
          workspace,
          {
            ...workspace,
            groupName: "other",
            selector: "other/main",
            path: "/work/other/main",
          },
        ],
        repositories: [],
      }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Workforest checkout settings" }),
    );
    expect(screen.queryByRole("option", { name: "other/main" })).toBeNull();
    expect(changes.at(-1).status).toBe("blocked");
    fireEvent.change(screen.getByLabelText("Workforest checkout"), {
      target: { value: entry.selector },
    });
    await waitFor(() => expect(changes.at(-1).status).toBe("ready"));
    fireEvent.change(screen.getByLabelText("Workforest mode"), {
      target: { value: "new" },
    });
    expect(screen.getByText("Source: @app")).toBeTruthy();
    expect(screen.queryByLabelText("Workforest source")).toBeNull();
  });
  it("carries the selected repository into new checkout creation without a source prompt", async () => {
    const { slot, changes } = mount({
      projectSource: () => ({
        id: "repository:example/toolbelt",
        kind: "repository",
        name: "toolbelt",
        source: "example/toolbelt",
        path: "/work/repos/toolbelt",
      }),
      bootstrap: () => ({
        ...bootstrap,
        projects: [
          {
            ...bootstrap.projects[0]!,
            sources: [
              ...bootstrap.projects[0]!.sources,
              { hostId: "h1", path: "/work/repos/toolbelt" },
            ],
          },
        ],
      }),
      projectSources: () => [
        {
          id: "repository:example/toolbelt",
          kind: "repository",
          name: "toolbelt",
          source: "example/toolbelt",
          path: "/work/repos/toolbelt",
        },
      ],
      sources: () => [
        {
          id: "repository:example/toolbelt",
          kind: "repository",
          name: "toolbelt",
          source: "example/toolbelt",
          path: "/work/repos/toolbelt",
        },
      ],
      inventory: () => ({
        workspaces: [workspace],
        repositories: [
          {
            ...entry,
            groupName: "toolbelt",
            selector: "toolbelt/main",
            path: "/work/repos/toolbelt/main",
          },
        ],
      }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Workforest checkout settings" }),
    );
    expect(screen.getByRole("option", { name: entry.selector })).toBeTruthy();
    expect(screen.getByRole("option", { name: "toolbelt/main" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Workforest mode"), {
      target: { value: "new" },
    });
    expect(screen.queryByLabelText("Workforest source")).toBeNull();
    expect(screen.getByText("Source: example/toolbelt")).toBeTruthy();
    expect(
      screen.getByText("Checkout name comes from this thread’s title."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(changes.at(-1)).toEqual({
        status: "ready",
        value: { mode: "new", source: "example/toolbelt" },
      }),
    );
  });
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
  it("filters all existing checkouts and creation sources to the selected project", async () => {
    const secondWorkspace = {
      ...workspace,
      groupName: "other",
      selector: "other/main",
      path: "/work/other/main",
    };
    const appSource = {
      id: "template:app",
      kind: "template" as const,
      name: "app",
      source: "@app",
      path: "/work/workspaces/app",
    };
    const toolSource = {
      id: "repository:example/toolbelt",
      kind: "repository" as const,
      name: "toolbelt",
      source: "example/toolbelt",
      path: "/work/repos/toolbelt",
    };
    const { slot } = mount({
      projectSources: () => [appSource, toolSource],
      projectSource: () => null,
      sources: () => [appSource, toolSource],
      inventory: () => ({
        workspaces: [workspace, secondWorkspace],
        repositories: [
          {
            ...entry,
            groupName: "toolbelt",
            selector: "toolbelt/main",
            path: "/work/repos/toolbelt/main",
          },
          {
            ...entry,
            groupName: "other",
            selector: "other/fix",
            path: "/work/other/fix",
          },
        ],
      }),
    });
    await slot.findByText("Coordinator · 2 repos");
    fireEvent.click(
      slot.getByRole("button", { name: "Workforest checkout settings" }),
    );
    expect(screen.getByRole("option", { name: entry.selector })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "other/main" })).toBeNull();
    expect(screen.getByRole("option", { name: "toolbelt/main" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "other/fix" })).toBeNull();
    fireEvent.change(slot.getByLabelText("Workforest mode"), {
      target: { value: "new" },
    });
    const sourceSelect = screen.getByLabelText("Workforest source");
    expect(sourceSelect.querySelectorAll("option")).toHaveLength(3);
    expect(sourceSelect.querySelector('[value="@app"]')).toBeTruthy();
    expect(
      sourceSelect.querySelector('[value="example/toolbelt"]'),
    ).toBeTruthy();
  });
  it("does not auto-select another machine's matching path", async () => {
    const { slot, changes } = mount(
      {},
      { target: { kind: "existing-host", hostId: "h2" } },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Workforest checkout settings" }),
    );
    await screen.findByText(
      "This project has no Workforest source for creating another checkout.",
    );
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
    await screen.findByText(
      "This project has no Workforest source for creating another checkout.",
    );
  });
  it("does not expose existing checkouts from another project", async () => {
    const { slot, changes } = mount(
      {},
      {
        projectId: "other",
        value: { mode: "existing", selector: entry.selector, path: entry.path },
      },
    );
    await slot.findByText("Create workspace…");
    fireEvent.click(
      slot.getByRole("button", { name: "Workforest checkout settings" }),
    );
    expect(screen.queryByRole("option", { name: entry.selector })).toBeNull();
    expect(changes.at(-1).status).toBe("blocked");
  });
  it("blocks creating a workspace outside the selected project sources", async () => {
    const { slot, changes } = mount();
    await slot.findByText("Coordinator · 2 repos");
    fireEvent.click(
      slot.getByRole("button", { name: "Workforest checkout settings" }),
    );
    fireEvent.change(screen.getByLabelText("Workforest mode"), {
      target: { value: "new" },
    });
    await screen.findByText(
      "This project has no Workforest source for creating another checkout.",
    );
    expect(changes.at(-1).status).toBe("blocked");
  });
  it("blocks new-machine selection rather than using stale inventory", async () => {
    const { slot, changes } = mount({}, { target: { kind: "new-host" } });
    await slot.findByText("Choose a connected machine to use Workforest.");
    expect(changes.at(-1).status).toBe("blocked");
    expect(slot.inspection.rpcCalls).toHaveLength(0);
  });
});
