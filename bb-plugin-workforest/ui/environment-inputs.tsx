import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Icon } from "../components/ui/icon.js";
import {
  useRpc,
  type PluginEnvironmentProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import type { Entry, WorkforestSource, rpcContract } from "../contracts.js";
import { ErrorMessage, selectClass } from "./shared.js";

type Choice =
  { mode: "new"; source: string } | { mode: "existing"; selector: string };

function belongsToSource(entry: Entry, source: WorkforestSource) {
  if (source.kind === "template")
    return (
      entry.groupName === source.name && entry.type === "template-workspace"
    );
  const root = source.path.replace(/\/$/u, "");
  return (
    entry.type === "worktree" &&
    entry.path.startsWith(`${root}/`) &&
    entry.selector.split("/", 1)[0] === source.name
  );
}
export function WorkforestInputs({
  projectId,
  target,
  value,
  onChange,
}: PluginEnvironmentProviderInputsProps) {
  const rpc = useRpc<typeof rpcContract>();
  const hostId = target.kind === "existing-host" ? target.hostId : null;
  const key = JSON.stringify([projectId, hostId]);
  const [loaded, setLoaded] = useState<{
    key: string;
    entries: Entry[];
    choice: Choice;
    source: WorkforestSource | null;
    sources: WorkforestSource[];
  }>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoaded(undefined);
    setError(undefined);
    onChange({ status: "blocked", reason: "Loading Workforest workspace…" });
    if (!hostId) {
      onChange({
        status: "blocked",
        reason: "Choose a connected machine to use Workforest.",
      });
      return;
    }
    void Promise.all([
      rpc.call("bootstrap", null),
      rpc.call("inventory", { hostId }),
      projectId
        ? Promise.all([
            rpc.call("projectSource", { hostId, projectId }),
            rpc.call("projectSources", { hostId, projectId }),
          ])
        : Promise.resolve([null, [] as WorkforestSource[]] as const),
    ])
      .then(([bootstrap, inventory, [source, sources]]) => {
        if (cancelled) return;
        const allEntries = [...inventory.workspaces, ...inventory.repositories];
        const project = bootstrap.projects.find(
          (item) => item.id === projectId,
        );
        const projectPaths = new Set(
          project?.sources
            .filter((item) => item.hostId === hostId)
            .map((item) => item.path) ?? [],
        );
        const scopedSources = sources;
        const entries = allEntries.filter(
          (entry) =>
            (projectPaths.has(entry.path) &&
              (entry.type === "template-workspace" ||
                entry.type === "worktree")) ||
            scopedSources.some((item) => belongsToSource(entry, item)),
        );
        const matches = entries.filter((entry) =>
          project?.sources.some(
            (item) => item.hostId === hostId && item.path === entry.path,
          ),
        );
        const saved =
          value && typeof value === "object" && !Array.isArray(value)
            ? value
            : null;
        let choice: Choice = source
          ? { mode: "existing", selector: "" }
          : { mode: "new", source: "" };
        if (
          source &&
          saved?.mode === "existing" &&
          typeof saved.selector === "string" &&
          entries.some(
            (entry) =>
              entry.selector === saved.selector && entry.path === saved.path,
          )
        )
          choice = { mode: "existing", selector: saved.selector };
        else if (!source && matches.length === 1)
          choice = { mode: "existing", selector: matches[0]!.selector };
        else if (saved?.mode === "new" && typeof saved.source === "string")
          choice = {
            mode: "new",
            source: source?.source ?? saved.source,
          };
        setLoaded({
          key,
          entries,
          choice,
          source,
          sources,
        });
      })
      .catch((cause) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        onChange({ status: "blocked", reason: message });
      });
    return () => {
      cancelled = true;
    };
  }, [key, retry]);
  const current = loaded?.key === key ? loaded : undefined;
  useEffect(() => {
    if (!current) return;
    const choice = current.choice;
    if (choice.mode === "existing") {
      const entry = current.entries.find(
        (entry) => entry.selector === choice.selector,
      );
      onChange(
        entry
          ? {
              status: "ready",
              value: {
                mode: "existing",
                selector: entry.selector,
                path: entry.path,
              },
            }
          : {
              status: "blocked",
              reason: "Choose an existing Workforest checkout.",
            },
      );
    } else {
      const valid = current.sources.some(
        (source) => source.source === choice.source,
      );
      onChange(
        valid
          ? { status: "ready", value: choice }
          : {
              status: "blocked",
              reason: "Choose a Workforest source.",
            },
      );
    }
  }, [current]);
  function choose(choice: Choice) {
    if (current) setLoaded({ ...current, choice });
  }
  if (error)
    return (
      <div>
        <ErrorMessage message={error} />
        <button type="button" onClick={() => setRetry(retry + 1)}>
          Retry Workforest loading
        </button>
      </div>
    );
  if (!hostId) return <p>Choose a connected machine to use Workforest.</p>;
  if (!current) return <p role="status">Loading Workforest workspace…</p>;
  const choice = current.choice;
  const entry =
    choice.mode === "existing"
      ? current.entries.find((entry) => entry.selector === choice.selector)
      : undefined;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 max-w-64 gap-1.5 text-sm text-muted-foreground"
          aria-label="Workforest checkout settings"
        >
          <span className="truncate">
            {entry
              ? entry.type === "worktree"
                ? "Repository checkout"
                : `Coordinator · ${entry.repos?.length ?? 0} repos`
              : choice.mode === "new"
                ? "Create workspace…"
                : "Choose checkout…"}
          </span>
          <Icon name="ChevronDown" className="size-3.5 shrink-0" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          aria-label="Workforest checkout settings"
          className="z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-4 text-sm text-popover-foreground shadow-md"
        >
          <div className="grid gap-3">
            <h3 className="font-medium">Workforest checkout</h3>
            <select
              className={selectClass}
              aria-label="Workforest mode"
              value={choice.mode}
              onChange={(event) =>
                choose(
                  event.target.value === "existing"
                    ? { mode: "existing", selector: "" }
                    : { mode: "new", source: current.source?.source ?? "" },
                )
              }
            >
              <option value="existing">Use existing checkout</option>
              <option value="new">Create new workspace</option>
            </select>
            {choice.mode === "existing" ? (
              <>
                <select
                  className={`${selectClass} w-full min-w-0`}
                  aria-label="Workforest checkout"
                  value={choice.selector}
                  onChange={(event) =>
                    choose({ mode: "existing", selector: event.target.value })
                  }
                >
                  <option value="">Select checkout…</option>
                  {current.entries.map((entry) => (
                    <option key={entry.selector} value={entry.selector}>
                      {entry.selector}
                    </option>
                  ))}
                </select>
                {entry && (
                  <p className="text-xs text-muted-foreground">
                    {entry.type === "worktree"
                      ? "Repository checkout"
                      : `Workspace coordinator · ${entry.repos?.length ?? 0} repositories · no root Git branch`}
                  </p>
                )}
              </>
            ) : (
              <>
                {current.sources.length === 1 ? (
                  <p className="text-xs text-muted-foreground">
                    Source: {current.sources[0]!.source}
                  </p>
                ) : current.sources.length > 1 ? (
                  <label>
                    Source
                    <select
                      className={selectClass}
                      aria-label="Workforest source"
                      value={choice.source}
                      onChange={(event) =>
                        choose({ ...choice, source: event.target.value })
                      }
                    >
                      <option value="">Select source…</option>
                      {current.sources.map((source) => (
                        <option key={source.id} value={source.source}>
                          {source.source}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    This project has no Workforest source for creating another
                    checkout.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Checkout name comes from this thread’s title.
                </p>
              </>
            )}
            <Popover.Close asChild>
              <Button type="button" variant="outline" size="sm">
                Done
              </Button>
            </Popover.Close>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
