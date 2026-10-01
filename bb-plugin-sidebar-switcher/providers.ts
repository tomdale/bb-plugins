// Pure model for the sidebar provider switcher: which exclusive sidebar slots
// exist, how a plugin bundle's registrations are discovered, and how a
// preference value maps to a choice. No React, no SDK runtime.

/** The exclusive sidebar slots BB lets the user pick a provider for. */
export type SidebarSlotKind = "threadList" | "navigation" | "header";

export const SIDEBAR_SLOT_KINDS: readonly SidebarSlotKind[] = [
  "threadList",
  "navigation",
  "header",
];

/** The server-synced UI preference that selects each slot's provider. */
export const PREFERENCE_KEY = {
  threadList: "sidebar.threadListProvider",
  navigation: "sidebar.navigationProvider",
  header: "sidebar.headerProvider",
} as const satisfies Record<SidebarSlotKind, string>;

export type SidebarPreferenceKey = (typeof PREFERENCE_KEY)[SidebarSlotKind];

/** The `app.slots` method a plugin calls to offer a provider for each slot. */
const SLOT_METHOD: Record<string, SidebarSlotKind> = {
  experimental_threadList: "threadList",
  experimental_sidebarNavigation: "navigation",
  experimental_sidebarHeader: "header",
};

export const SLOT_LABEL: Record<SidebarSlotKind, string> = {
  threadList: "Sidebar",
  navigation: "Navigation",
  header: "Header",
};

export const AUTOMATIC = "__automatic__";
export const BUILTIN = "__builtin__";

/** BB's bundled providers, which `__automatic__` passes over when another exists. */
export const BUNDLED_DEFAULT: Partial<Record<SidebarSlotKind, string>> = {
  threadList: "thread-list/thread-list",
  navigation: "navigation/navigation",
};

/** One slot registration found in a plugin's frontend setup. */
export interface SlotRegistration {
  kind: SidebarSlotKind;
  id: string;
  title: string;
  description: string | null;
}

/** A selectable provider: a registration attributed to its plugin. */
export interface ProviderOption {
  /** Preference value, `<pluginId>/<slotId>`. */
  value: string;
  pluginId: string;
  pluginName: string;
  title: string;
  description: string | null;
}

/** A row in the switcher: a provider or one of BB's sentinel choices. */
export interface Choice {
  value: string;
  label: string;
  detail: string | null;
  /** True when the preference names a provider that is not currently installed and enabled. */
  isUnavailable: boolean;
}

/**
 * Cheap text test that decides whether a bundle is worth interpreting. A
 * false positive (the method name inside a string) is harmless because
 * interpretation records only real calls.
 */
export function bundleMayRegisterSidebarSlots(source: string): boolean {
  return Object.keys(SLOT_METHOD).some((method) =>
    source.includes(`${method}(`),
  );
}

/**
 * Returns a value that absorbs any property read or call, so a plugin's
 * setup can run against it without reaching the real host. It is not
 * thenable, so `await` on it resolves immediately.
 */
function createSink(): unknown {
  const sink: unknown = new Proxy(function sinkTarget() {}, {
    get: (_target, property) =>
      property === "then" || typeof property === "symbol" ? undefined : sink,
    apply: () => sink,
    construct: () => sink as object,
  });
  return sink;
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Runs a plugin app definition's `setup` against a recording builder and
 * returns the sidebar slot registrations it makes. BB re-runs `setup` on every
 * reinterpretation, so calling it again is within its contract; every other
 * builder surface is a no-op sink. A setup that throws yields whatever it
 * registered before the throw.
 */
export function collectSidebarRegistrations(
  definition: unknown,
): SlotRegistration[] {
  if (typeof definition !== "object" || definition === null) return [];
  const { __bbPluginApp, setup } = definition as {
    __bbPluginApp?: unknown;
    setup?: unknown;
  };
  if (__bbPluginApp !== true || typeof setup !== "function") return [];

  const found: SlotRegistration[] = [];
  const sink = createSink();
  const slots = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === "symbol" || property === "then")
          return undefined;
        const kind = SLOT_METHOD[property];
        if (kind === undefined) return sink;
        return (registration: unknown) => {
          if (typeof registration !== "object" || registration === null)
            return;
          const record = registration as Record<string, unknown>;
          const id = stringField(record, "id");
          if (id === null) return;
          found.push({
            kind,
            id,
            title: stringField(record, "title") ?? id,
            description: stringField(record, "description"),
          });
        };
      },
    },
  );
  const builder = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === "symbol" || property === "then")
          return undefined;
        return property === "slots" ? slots : sink;
      },
    },
  );
  try {
    (setup as (app: unknown) => unknown)(builder);
  } catch {
    // Keep the registrations recorded before the throw.
  }
  return found;
}

/** Orders providers the way BB's Appearance settings list them: by title. */
export function sortProviders(
  providers: readonly ProviderOption[],
): ProviderOption[] {
  return [...providers].sort(
    (a, b) =>
      a.title.localeCompare(b.title) || a.value.localeCompare(b.value),
  );
}

/**
 * The provider `__automatic__` resolves to: the first provider other than
 * BB's bundled default, else the bundled default. BB orders candidates by its
 * own registration order, which this approximates with plugin-id order.
 */
export function resolveAutomatic(
  kind: SidebarSlotKind,
  providers: readonly ProviderOption[],
): ProviderOption | null {
  const byPlugin = [...providers].sort(
    (a, b) =>
      a.pluginId.localeCompare(b.pluginId) || a.value.localeCompare(b.value),
  );
  const bundled = BUNDLED_DEFAULT[kind];
  return byPlugin.find((p) => p.value !== bundled) ?? byPlugin[0] ?? null;
}

/** Maps legacy preference values to the ones BB resolves them to. */
export function normalizePreference(
  kind: SidebarSlotKind,
  value: string,
): string {
  if (kind === "header") return value === AUTOMATIC ? BUILTIN : value;
  if (value === BUILTIN) return BUNDLED_DEFAULT[kind] ?? value;
  return value;
}

/**
 * The switcher's rows for one slot: every provider by title, with the header
 * slot's None first. BB's Automatic sentinel is listed only while it is the
 * saved value, so picking a provider hides it; a saved value naming a
 * missing provider is appended so the current state is always visible.
 */
export function choicesFor(
  kind: SidebarSlotKind,
  providers: readonly ProviderOption[],
  currentValue: string | null,
): Choice[] {
  const choices: Choice[] = [
    ...(kind === "header"
      ? [{ value: BUILTIN, label: "None", detail: "BB's own header only", isUnavailable: false }]
      : currentValue === AUTOMATIC
        ? [{ value: AUTOMATIC, label: "Automatic", detail: null, isUnavailable: false }]
        : []),
    ...sortProviders(providers).map((provider) => ({
      value: provider.value,
      label: provider.title,
      detail: provider.pluginName === provider.title ? null : provider.pluginName,
      isUnavailable: false,
    })),
  ];
  if (
    currentValue !== null &&
    !choices.some((choice) => choice.value === currentValue)
  ) {
    choices.push({
      value: currentValue,
      label: currentValue,
      detail: "Not installed or disabled",
      isUnavailable: true,
    });
  }
  return choices;
}

/**
 * The provider before or after the effective current one in title order,
 * wrapping around. An automatic or unknown current value counts as its
 * resolved provider.
 */
export function stepProvider(
  kind: SidebarSlotKind,
  providers: readonly ProviderOption[],
  currentValue: string | null,
  direction: 1 | -1,
): ProviderOption | null {
  const ordered = sortProviders(providers);
  if (ordered.length === 0) return null;
  let index = ordered.findIndex((p) => p.value === currentValue);
  if (index === -1) {
    const resolved =
      kind === "header" ? null : resolveAutomatic(kind, ordered);
    index = resolved === null ? -1 : ordered.indexOf(resolved);
  }
  if (index === -1) return direction === 1 ? ordered[0]! : ordered.at(-1)!;
  return ordered[(index + direction + ordered.length) % ordered.length]!;
}
