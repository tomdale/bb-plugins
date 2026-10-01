import { describe, expect, it } from "vitest";
import {
  bundleMayRegisterSidebarSlots,
  choicesFor,
  collectSidebarRegistrations,
  normalizePreference,
  resolveAutomatic,
  stepProvider,
  type ProviderOption,
} from "./providers";

const definition = (setup: (app: any) => void) => ({
  __bbPluginApp: true,
  setup,
});

function provider(pluginId: string, slotId: string, title: string): ProviderOption {
  return {
    value: `${pluginId}/${slotId}`,
    pluginId,
    pluginName: title,
    title,
    description: null,
  };
}

describe("bundleMayRegisterSidebarSlots", () => {
  it("matches minified slot calls", () => {
    expect(
      bundleMayRegisterSidebarSlots(
        'var x=Ub(e=>{e.slots.experimental_threadList({id:"t",title:"T"})})',
      ),
    ).toBe(true);
    expect(bundleMayRegisterSidebarSlots("e.slots.navPanel({id:1})")).toBe(false);
  });
});

describe("collectSidebarRegistrations", () => {
  it("records only sidebar slot registrations and ignores every other surface", () => {
    const found = collectSidebarRegistrations(
      definition((app) => {
        app.slots.navPanel({ id: "page" });
        const controller = app.experimental_sidebarFooter.register({
          kind: "disclosure",
          id: "d",
        });
        controller.open();
        app.commands.register({ id: "c", run() {} });
        app.composer.customize({ id: "x" });
        app.slots.experimental_threadList({
          id: "sidebar",
          title: "Workstreams",
          description: "Grouped",
        });
        app.slots.experimental_sidebarNavigation({ id: "nav", title: "Nav" });
        app.slots.experimental_sidebarHeader({ id: "head" });
      }),
    );
    expect(found).toEqual([
      { kind: "threadList", id: "sidebar", title: "Workstreams", description: "Grouped" },
      { kind: "navigation", id: "nav", title: "Nav", description: null },
      { kind: "header", id: "head", title: "head", description: null },
    ]);
  });

  it("keeps registrations made before setup throws", () => {
    const found = collectSidebarRegistrations(
      definition((app) => {
        app.slots.experimental_threadList({ id: "a", title: "A" });
        throw new Error("boom");
      }),
    );
    expect(found.map((r) => r.id)).toEqual(["a"]);
  });

  it("rejects values that are not plugin app definitions", () => {
    expect(collectSidebarRegistrations(null)).toEqual([]);
    expect(collectSidebarRegistrations({ setup() {} })).toEqual([]);
  });

  it("does not make the sink thenable", async () => {
    let resolved = false;
    collectSidebarRegistrations(
      definition((app) => {
        void Promise.resolve(app.whatever).then(() => {
          resolved = true;
        });
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);
  });
});

describe("preferences and choices", () => {
  const bundled = provider("thread-list", "thread-list", "Thread list");
  const workstreams = provider("workstreams", "sidebar", "Workstreams");
  const inbox = provider("inbox", "inbox", "Inbox");

  it("normalizes legacy sentinels the way BB does", () => {
    expect(normalizePreference("threadList", "__builtin__")).toBe("thread-list/thread-list");
    expect(normalizePreference("navigation", "__builtin__")).toBe("navigation/navigation");
    expect(normalizePreference("header", "__automatic__")).toBe("__builtin__");
  });

  it("resolves Automatic to the first non-bundled provider", () => {
    expect(resolveAutomatic("threadList", [bundled, workstreams, inbox])).toBe(inbox);
    expect(resolveAutomatic("threadList", [bundled])).toBe(bundled);
    expect(resolveAutomatic("threadList", [])).toBeNull();
  });

  it("lists providers by title, then a missing saved value", () => {
    const choices = choicesFor("threadList", [workstreams, bundled], "gone/list");
    expect(choices.map((c) => c.value)).toEqual([
      "thread-list/thread-list",
      "workstreams/sidebar",
      "gone/list",
    ]);
    expect(choices.at(-1)?.isUnavailable).toBe(true);
    expect(choicesFor("header", [], "__builtin__").map((c) => c.label)).toEqual(["None"]);
  });

  it("lists Automatic only while it is the saved value", () => {
    expect(
      choicesFor("threadList", [workstreams, bundled], "__automatic__").map((c) => c.value),
    ).toEqual(["__automatic__", "thread-list/thread-list", "workstreams/sidebar"]);
    expect(
      choicesFor("threadList", [workstreams, bundled], "workstreams/sidebar").map((c) => c.value),
    ).toEqual(["thread-list/thread-list", "workstreams/sidebar"]);
  });

  it("steps providers in title order in both directions and wraps", () => {
    const all = [bundled, workstreams, inbox];
    expect(stepProvider("threadList", all, "inbox/inbox", 1)).toBe(bundled);
    expect(stepProvider("threadList", all, "workstreams/sidebar", 1)).toBe(inbox);
    expect(stepProvider("threadList", all, "inbox/inbox", -1)).toBe(workstreams);
    expect(stepProvider("threadList", all, "thread-list/thread-list", -1)).toBe(inbox);
    // Automatic counts as the provider it resolves to (inbox).
    expect(stepProvider("threadList", all, "__automatic__", 1)).toBe(bundled);
    expect(stepProvider("threadList", all, "__automatic__", -1)).toBe(workstreams);
    expect(stepProvider("threadList", [], "__automatic__", 1)).toBeNull();
  });
});
