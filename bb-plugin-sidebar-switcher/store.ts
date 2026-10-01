// App-wide switcher state shared by the footer disclosure and palette
// commands. One store per window: provider discovery is cached by bundle
// hash, and preferences are re-read from the server before every change so a
// choice made in Settings → Appearance or another window is never clobbered.
import {
  bundleMayRegisterSidebarSlots,
  collectSidebarRegistrations,
  normalizePreference,
  PREFERENCE_KEY,
  SIDEBAR_SLOT_KINDS,
  type ProviderOption,
  type SidebarPreferenceKey,
  type SidebarSlotKind,
  type SlotRegistration,
} from "./providers";

/** The installed-plugin fields discovery reads. */
export interface PluginSummary {
  id: string;
  name: string;
  enabled: boolean;
  app: {
    bundle: { jsUrl: string; hash: string; compatible: boolean } | null;
  };
}

export interface PreferenceEntry {
  value: string;
  revision: number;
}

/** The host operations the store needs; `browserBackend` adapts the SDK. */
export interface SwitcherBackend {
  listPlugins(): Promise<PluginSummary[]>;
  listPreferences(): Promise<Record<SidebarPreferenceKey, PreferenceEntry>>;
  setPreference(
    key: SidebarPreferenceKey,
    value: string,
    expectedRevision: number,
  ): Promise<PreferenceEntry>;
  /** Source text of a plugin bundle, for the cheap prefilter. */
  fetchBundleText(jsUrl: string): Promise<string>;
  /**
   * The bundle's module namespace. BB imports each bundle by this same URL,
   * so the module map returns the instance BB already evaluated.
   */
  importBundle(jsUrl: string): Promise<{ default?: unknown }>;
}

export type Providers = Record<SidebarSlotKind, ProviderOption[]>;
export type Preferences = Record<SidebarSlotKind, PreferenceEntry>;

export interface SwitcherState {
  status: "idle" | "loading" | "ready" | "error";
  providers: Providers;
  preferences: Preferences | null;
  /** The value being written, per slot, until the server confirms it. */
  pending: Partial<Record<SidebarSlotKind, string>>;
  error: string | null;
}

const emptyProviders = (): Providers => ({
  threadList: [],
  navigation: [],
  header: [],
});

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export function createSwitcherStore(options: { ownPluginId: string }) {
  let backend: SwitcherBackend | null = null;
  let state: SwitcherState = {
    status: "idle",
    providers: emptyProviders(),
    preferences: null,
    pending: {},
    error: null,
  };
  const listeners = new Set<() => void>();
  const registrationsByHash = new Map<string, Promise<SlotRegistration[]>>();
  let inflight: Promise<void> | null = null;

  function update(patch: Partial<SwitcherState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function requireBackend() {
    if (backend === null) throw new Error("Sidebar switcher is not ready yet.");
    return backend;
  }

  function registrationsFor(
    host: SwitcherBackend,
    bundle: { jsUrl: string; hash: string },
  ) {
    let cached = registrationsByHash.get(bundle.hash);
    if (cached === undefined) {
      cached = (async () => {
        const source = await host.fetchBundleText(bundle.jsUrl);
        if (!bundleMayRegisterSidebarSlots(source)) return [];
        const namespace = await host.importBundle(bundle.jsUrl);
        return collectSidebarRegistrations(namespace.default);
      })().catch((cause: unknown) => {
        // A transient failure should not stick for the session.
        registrationsByHash.delete(bundle.hash);
        console.warn(
          `[sidebar-switcher] could not inspect ${bundle.jsUrl}: ${message(cause)}`,
        );
        return [];
      });
      registrationsByHash.set(bundle.hash, cached);
    }
    return cached;
  }

  async function discoverProviders(host: SwitcherBackend): Promise<Providers> {
    const plugins = await host.listPlugins();
    const providers = emptyProviders();
    await Promise.all(
      plugins.map(async (plugin) => {
        const bundle = plugin.app.bundle;
        if (
          !plugin.enabled ||
          plugin.id === options.ownPluginId ||
          bundle === null ||
          !bundle.compatible
        )
          return;
        for (const registration of await registrationsFor(host, bundle)) {
          providers[registration.kind].push({
            value: `${plugin.id}/${registration.id}`,
            pluginId: plugin.id,
            pluginName: plugin.name,
            title: registration.title,
            description: registration.description,
          });
        }
      }),
    );
    return providers;
  }

  async function readPreferences(host: SwitcherBackend): Promise<Preferences> {
    const entries = await host.listPreferences();
    const preferences = {} as Preferences;
    for (const kind of SIDEBAR_SLOT_KINDS) {
      const entry = entries[PREFERENCE_KEY[kind]];
      preferences[kind] = {
        value: normalizePreference(kind, entry.value),
        revision: entry.revision,
      };
    }
    return preferences;
  }

  /** Re-reads providers and preferences; concurrent callers share one read. */
  function refresh(): Promise<void> {
    if (inflight !== null) return inflight;
    const host = requireBackend();
    if (state.status !== "ready") update({ status: "loading", error: null });
    inflight = (async () => {
      try {
        const [providers, preferences] = await Promise.all([
          discoverProviders(host),
          readPreferences(host),
        ]);
        update({ status: "ready", providers, preferences, error: null });
      } catch (cause) {
        update({ status: "error", error: message(cause) });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /**
   * Writes one slot's provider. Reads the revision first; on a revision
   * conflict it re-reads once and retries, so a concurrent change elsewhere
   * cannot silently win or lose.
   */
  async function select(kind: SidebarSlotKind, value: string) {
    const host = requireBackend();
    const key = PREFERENCE_KEY[kind];
    update({ pending: { ...state.pending, [kind]: value }, error: null });
    try {
      let preferences = await readPreferences(host);
      let saved: PreferenceEntry;
      try {
        saved = await host.setPreference(key, value, preferences[kind].revision);
      } catch {
        preferences = await readPreferences(host);
        saved = await host.setPreference(key, value, preferences[kind].revision);
      }
      update({
        preferences: {
          ...preferences,
          [kind]: {
            value: normalizePreference(kind, saved.value),
            revision: saved.revision,
          },
        },
      });
    } catch (cause) {
      update({ error: message(cause) });
      throw cause;
    } finally {
      const { [kind]: _done, ...rest } = state.pending;
      update({ pending: rest });
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Attaches the host; the first attachment starts discovery. */
    attach(next: SwitcherBackend) {
      const first = backend === null;
      backend = next;
      if (first) void refresh();
    },
    detach(previous: SwitcherBackend) {
      if (backend === previous) backend = null;
    },
    isAttached: () => backend !== null,
    refresh,
    select,
  };
}

export type SwitcherStore = ReturnType<typeof createSwitcherStore>;
