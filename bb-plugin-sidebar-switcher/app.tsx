// Sidebar Switcher frontend: a sidebar-footer disclosure and palette commands
// that change which plugin renders BB's thread list, navigation, and header,
// without a trip to Settings → Appearance.
import { useEffect, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  useSdk,
  type ExperimentalSidebarFooterDisclosureProps,
  type PluginBrowserBbSdk,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  choicesFor,
  nextProvider,
  SIDEBAR_SLOT_KINDS,
  SLOT_LABEL,
  type Choice,
  type SidebarSlotKind,
} from "./providers";
import {
  createSwitcherStore,
  type PluginSummary,
  type SwitcherBackend,
  type SwitcherState,
} from "./store";

const PLUGIN_ID = "sidebar-switcher";
const store = createSwitcherStore({ ownPluginId: PLUGIN_ID });

function browserBackend(sdk: PluginBrowserBbSdk): SwitcherBackend {
  return {
    async listPlugins() {
      const { plugins } = await sdk.plugins.list();
      return plugins as PluginSummary[];
    },
    async listPreferences() {
      const { preferences } = await sdk.system.uiPreferences.list();
      return preferences;
    },
    async setPreference(key, value, expectedRevision) {
      const saved = await sdk.system.uiPreferences.set({
        key,
        value,
        expectedRevision,
      });
      return { value: saved.value, revision: saved.revision };
    },
    async fetchBundleText(jsUrl) {
      const response = await fetch(jsUrl, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
    importBundle: (jsUrl) => import(/* @vite-ignore */ jsUrl),
  };
}

/**
 * Renders nothing; hands the app-scoped SDK to the store so palette commands,
 * which run outside React, can read and write preferences.
 */
function HostBridge() {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  useEffect(() => {
    if (pluginId !== PLUGIN_ID) {
      console.warn(
        `[sidebar-switcher] loaded as "${pluginId}"; expected "${PLUGIN_ID}"`,
      );
    }
    const backend = browserBackend(sdk);
    store.attach(backend);
    return () => store.detach(backend);
  }, [sdk, pluginId]);
  return null;
}

function useSwitcherState(): SwitcherState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** A slot is worth showing only when there is more than one real choice. */
function hasAlternatives(kind: SidebarSlotKind, state: SwitcherState) {
  const providers = state.providers[kind];
  return kind === "header" ? providers.length >= 1 : providers.length >= 2;
}

function ChoiceRow({
  choice,
  isSelected,
  isPending,
  disabled,
  onSelect,
}: {
  choice: Choice;
  isSelected: boolean;
  isPending: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={isSelected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm",
        "text-sidebar-foreground hover:bg-sidebar-accent focus-visible:bg-sidebar-accent focus-visible:outline-none",
        "disabled:cursor-default disabled:opacity-60",
        isSelected && "font-medium",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {isPending ? (
          <Icon name="Spinner" className="size-3.5 animate-spin" />
        ) : isSelected ? (
          <Icon name="Check" className="size-3.5" />
        ) : null}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          choice.isUnavailable && "text-muted-foreground line-through",
        )}
      >
        {choice.label}
      </span>
      {choice.detail === null ? null : (
        <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
          {choice.detail}
        </span>
      )}
    </button>
  );
}

function SlotSection({
  kind,
  state,
  dismiss,
}: {
  kind: SidebarSlotKind;
  state: SwitcherState;
  dismiss: () => void;
}) {
  const saved = state.preferences?.[kind].value ?? null;
  const pending = state.pending[kind];
  const selected = pending ?? saved;
  const choices = choicesFor(kind, state.providers[kind], saved);
  return (
    <div role="group" aria-label={SLOT_LABEL[kind]} className="py-1">
      <div className="px-2 pb-0.5 pt-1 text-xs font-medium text-muted-foreground">
        {SLOT_LABEL[kind]}
      </div>
      {choices.map((choice) => (
        <ChoiceRow
          key={choice.value}
          choice={choice}
          isSelected={choice.value === selected}
          isPending={choice.value === pending}
          disabled={pending !== undefined || choice.isUnavailable}
          onSelect={() => {
            // Close at once; the write lives in the store and reports
            // failure by toast, so it outlives this menu.
            dismiss();
            if (choice.value === selected) return;
            store.select(kind, choice.value).catch((cause: unknown) => {
              toast.error(
                `Could not switch ${SLOT_LABEL[kind].toLowerCase()}: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              );
            });
          }}
        />
      ))}
    </div>
  );
}

function SwitcherDisclosure({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const state = useSwitcherState();
  useEffect(() => {
    // Pick up plugins enabled or preferences changed since the last open.
    if (store.isAttached()) void store.refresh();
  }, []);
  const kinds = SIDEBAR_SLOT_KINDS.filter((kind) => hasAlternatives(kind, state));
  return (
    <div
      role="menu"
      aria-label="Sidebar plugins"
      className="max-h-[60vh] overflow-y-auto rounded-lg bg-sidebar-accent/40 p-1"
      onKeyDown={(event) => {
        if (event.key === "Escape") dismiss();
      }}
    >
      {state.status === "ready" || state.preferences !== null ? (
        kinds.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            No alternative sidebar plugins are enabled.
          </p>
        ) : (
          kinds.map((kind) => <SlotSection key={kind} kind={kind} state={state} dismiss={dismiss} />)
        )
      ) : state.status === "error" ? null : (
        <p className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
          <Icon name="Spinner" className="size-3.5 animate-spin" />
          Finding sidebar plugins…
        </p>
      )}
      {state.error === null ? null : (
        <p role="alert" className="px-2 py-1.5 text-xs text-destructive">
          {state.error}
        </p>
      )}
    </div>
  );
}

async function switchToNextThreadList() {
  await store.refresh();
  const state = store.getState();
  if (state.status === "error") {
    toast.error(`Could not read sidebar plugins: ${state.error}`);
    return;
  }
  const current = state.preferences?.threadList.value ?? null;
  const next = nextProvider("threadList", state.providers.threadList, current);
  if (next === null || next.value === current) {
    toast("No other thread list plugin is enabled.");
    return;
  }
  try {
    await store.select("threadList", next.value);
    toast(`Thread list: ${next.title}`);
  } catch (cause) {
    toast.error(
      `Could not switch thread list: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "host-bridge", component: HostBridge });

  const disclosure = app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "switcher",
    label: "Sidebar plugins",
    icon: "PanelLeft",
    component: SwitcherDisclosure,
  });

  app.commands.register({
    id: "next-thread-list",
    title: "Switch to next sidebar thread list",
    defaultShortcut: { key: "l", mod: true, alt: true },
    isAvailable: () => store.isAttached(),
    run: switchToNextThreadList,
  });
  app.commands.register({
    id: "choose",
    title: "Choose sidebar plugins…",
    run: () => disclosure.open(),
  });
});
