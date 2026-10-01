import { useRpc, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { useState, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Icon } from "../components/ui/icon.js";
import { Input } from "../components/ui/input.js";
import type { Bootstrap, rpcContract } from "../contracts.js";
import { useResource } from "../hooks/use-resource.js";
import { Empty, ErrorMessage, selectClass } from "./shared.js";

type PickerComposer = Pick<
  PluginComposerApi,
  "isSubmitting" | "selection" | "setSelection" | "focus"
>;
let pickerComposer: PickerComposer | null = null;
const listeners = new Set<() => void>();
function setPickerComposer(next: PickerComposer | null) {
  pickerComposer = next;
  listeners.forEach((listener) => listener());
}

/** Opens one app-level picker for the composer whose `+` menu item was chosen. */
export function openWorkforestProjectPicker(composer: PickerComposer) {
  setPickerComposer(composer);
}

export function WorkforestProjectOverlay() {
  const composer = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pickerComposer,
  );
  return composer ? (
    <ProjectPicker composer={composer} close={() => setPickerComposer(null)} />
  ) : null;
}

function ProjectPicker({
  composer,
  close,
}: {
  composer: PickerComposer;
  close: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const bootstrap = useResource(
    "composer-projects",
    () => rpc.call("bootstrap", null),
    0,
  );
  const [chosenHost, setChosenHost] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const environment = composer.selection?.environment;
  const preferredHost =
    environment?.type === "host" ? environment.hostId : undefined;
  const hosts =
    bootstrap.data?.hosts.filter((host) => host.status === "connected") ?? [];
  const hostId =
    chosenHost ??
    hosts.find((host) => host.id === preferredHost)?.id ??
    hosts[0]?.id;

  async function select(selector: string) {
    if (!hostId || pending || composer.isSubmitting) return;
    setPending(true);
    setError(undefined);
    try {
      const project = await rpc.call("project", { hostId, selector });
      // Select the checkout explicitly rather than retaining the previous project's worktree choice.
      const settled = await composer.setSelection({
        projectId: project.projectId,
        environment: {
          type: "host",
          hostId,
          workspace: { type: "unmanaged", path: project.path },
        },
      });
      if (settled.projectId !== project.projectId)
        throw new Error(
          "Project was registered but could not be selected. Choose it in the project selector.",
        );
      close();
      composer.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      bootstrap.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Workforest → BB project</DialogTitle>
          <DialogDescription>
            Select an existing checkout to create or reuse its BB project and
            select it in this composer. Your draft stays here; no checkout or
            thread is created.
          </DialogDescription>
        </DialogHeader>
        <ErrorMessage message={bootstrap.error || error} />
        {bootstrap.error && (
          <Button type="button" variant="outline" onClick={bootstrap.refresh}>
            Retry loading machines
          </Button>
        )}
        {!bootstrap.data ? (
          <Empty>Loading machines…</Empty>
        ) : !hosts.length ? (
          <Empty>
            No connected machines. Connect a machine with Workforest installed.
          </Empty>
        ) : (
          <>
            <label className="grid gap-2 text-sm">
              Machine
              <select
                className={selectClass}
                value={hostId}
                disabled={pending}
                onChange={(event) => {
                  setChosenHost(event.target.value);
                  setError(undefined);
                }}
              >
                {hosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name}
                  </option>
                ))}
              </select>
            </label>
            {hostId && (
              <CheckoutList
                key={hostId}
                hostId={hostId}
                projects={bootstrap.data.projects}
                disabled={pending || composer.isSubmitting}
                select={select}
              />
            )}
          </>
        )}
        {pending && (
          <p role="status" className="text-sm text-muted-foreground">
            Registering and selecting project…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CheckoutList({
  hostId,
  projects,
  disabled,
  select,
}: {
  hostId: string;
  projects: Bootstrap["projects"];
  disabled: boolean;
  select: (selector: string) => Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const inventory = useResource(
    `composer-inventory:${hostId}`,
    () => rpc.call("inventory", { hostId }),
    0,
  );
  const [query, setQuery] = useState("");
  const entries = [
    ...(inventory.data?.workspaces ?? []),
    ...(inventory.data?.repositories ?? []),
  ]
    .filter((entry) =>
      [entry.selector, entry.path, ...(entry.repos ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .sort((a, b) => a.selector.localeCompare(b.selector));
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          aria-label="Search Workforest checkouts"
          placeholder="Search workspaces, worktrees, or paths…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Refresh checkouts"
          disabled={disabled}
          onClick={inventory.refresh}
        >
          <Icon name="RotateCcw" className="size-4" />
        </Button>
      </div>
      <ErrorMessage message={inventory.error} />
      {!inventory.data ? (
        <Empty>
          {inventory.error
            ? "Refresh after resolving the machine error."
            : "Loading Workforest checkouts…"}
        </Empty>
      ) : !entries.length ? (
        <Empty>
          {query
            ? "No matching checkouts."
            : "No Workforest checkouts on this machine."}
        </Empty>
      ) : (
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {entries.map((entry) => {
            const existing = projects.find((project) =>
              project.sources.some(
                (source) =>
                  source.hostId === hostId && source.path === entry.path,
              ),
            );
            return (
              <li key={entry.selector}>
                <button
                  type="button"
                  disabled={disabled || Boolean(inventory.error)}
                  aria-label={`${existing ? "Use project for" : "Create project for"} ${entry.selector}`}
                  onClick={() => void select(entry.selector)}
                  className="flex w-full items-center justify-between gap-3 rounded-md p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {entry.selector}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {entry.type === "worktree" ? "Worktree" : "Workspace"}
                      {existing ? ` · ${existing.name}` : ""}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {entry.path}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {existing ? "Use project" : "Create & select"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
