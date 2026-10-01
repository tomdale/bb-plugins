import { describe, expect, it, vi } from "vitest";
import type { SidebarPreferenceKey } from "./providers";
import {
  createSwitcherStore,
  type PluginSummary,
  type PreferenceEntry,
  type SwitcherBackend,
} from "./store";

function plugin(id: string, enabled = true): PluginSummary {
  return {
    id,
    name: id,
    enabled,
    app: { bundle: { jsUrl: `/assets/${id}.js`, hash: id, compatible: true } },
  };
}

function fakeBackend(
  bundles: Record<string, (app: any) => void>,
  plugins: PluginSummary[],
) {
  const preferences: Record<SidebarPreferenceKey, PreferenceEntry> = {
    "sidebar.threadListProvider": { value: "__automatic__", revision: 3 },
    "sidebar.navigationProvider": { value: "__builtin__", revision: 1 },
    "sidebar.headerProvider": { value: "__builtin__", revision: 0 },
  };
  const imported: string[] = [];
  const backend: SwitcherBackend = {
    listPlugins: async () => plugins,
    listPreferences: async () => structuredClone(preferences),
    setPreference: vi.fn<SwitcherBackend["setPreference"]>(async (key, value, expectedRevision) => {
      if (expectedRevision !== preferences[key].revision) {
        throw new Error("revision conflict");
      }
      preferences[key] = { value, revision: expectedRevision + 1 };
      return preferences[key];
    }),
    fetchBundleText: async (jsUrl) => {
      const id = jsUrl.slice("/assets/".length, -".js".length);
      return bundles[id] === undefined ? "plain bundle" : "app.slots.experimental_threadList(";
    },
    importBundle: async (jsUrl) => {
      imported.push(jsUrl);
      const id = jsUrl.slice("/assets/".length, -".js".length);
      return { default: { __bbPluginApp: true, setup: bundles[id] } };
    },
  };
  return { backend, preferences, imported };
}

describe("switcher store", () => {
  const bundles = {
    "thread-list": (app: any) =>
      app.slots.experimental_threadList({ id: "thread-list", title: "Thread list" }),
    workstreams: (app: any) =>
      app.slots.experimental_threadList({ id: "sidebar", title: "Workstreams" }),
    "sidebar-switcher": (app: any) =>
      app.slots.experimental_threadList({ id: "self", title: "Self" }),
    disabled: (app: any) =>
      app.slots.experimental_threadList({ id: "off", title: "Off" }),
  };

  it("discovers enabled providers, skipping itself and bundles without sidebar slots", async () => {
    const { backend, imported } = fakeBackend(bundles, [
      plugin("thread-list"),
      plugin("workstreams"),
      plugin("sidebar-switcher"),
      plugin("disabled", false),
      plugin("plain"),
    ]);
    const store = createSwitcherStore({ ownPluginId: "sidebar-switcher" });
    store.attach(backend);
    await store.refresh();
    const state = store.getState();
    expect(state.status).toBe("ready");
    expect(state.providers.threadList.map((p) => p.value).sort()).toEqual([
      "thread-list/thread-list",
      "workstreams/sidebar",
    ]);
    expect(state.preferences?.navigation.value).toBe("navigation/navigation");
    expect(imported.sort()).toEqual(["/assets/thread-list.js", "/assets/workstreams.js"]);

    // Bundles are cached by hash across refreshes.
    await store.refresh();
    expect(imported).toHaveLength(2);
  });

  it("retries a write once after a revision conflict", async () => {
    const { backend, preferences } = fakeBackend(bundles, [plugin("workstreams")]);
    const store = createSwitcherStore({ ownPluginId: "sidebar-switcher" });
    store.attach(backend);
    await store.refresh();

    const original = backend.listPreferences;
    let calls = 0;
    backend.listPreferences = async () => {
      calls += 1;
      const snapshot = await original();
      // The first read is stale: another window wrote in between.
      if (calls === 1) snapshot["sidebar.threadListProvider"].revision -= 1;
      return snapshot;
    };

    await store.select("threadList", "workstreams/sidebar");
    expect(backend.setPreference).toHaveBeenCalledTimes(2);
    expect(preferences["sidebar.threadListProvider"]).toEqual({
      value: "workstreams/sidebar",
      revision: 4,
    });
    expect(store.getState().preferences?.threadList.value).toBe("workstreams/sidebar");
    expect(store.getState().pending).toEqual({});
  });
});
