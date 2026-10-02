import { useEffect, useState } from "react";
import {
  useRpc,
  type PluginEnvironmentProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import type { Entry, Template, rpcContract } from "../contracts.js";
import { ErrorMessage } from "./shared.js";

type Choice =
  | { mode: "new"; source: string; name: string }
  | { mode: "existing"; selector: string };
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
    templates: Template[];
    choice: Choice;
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
      rpc.call("templates", { hostId }),
    ])
      .then(([bootstrap, inventory, templates]) => {
        if (cancelled) return;
        const entries = [...inventory.workspaces, ...inventory.repositories];
        const project = bootstrap.projects.find(
          (project) => project.id === projectId,
        );
        const matches = inventory.workspaces.filter((entry) =>
          project?.sources.some(
            (source) => source.hostId === hostId && source.path === entry.path,
          ),
        );
        const saved =
          value && typeof value === "object" && !Array.isArray(value)
            ? value
            : null;
        let choice: Choice = { mode: "new", source: "", name: "" };
        if (matches.length === 1)
          choice = { mode: "existing", selector: matches[0]!.selector };
        else if (
          saved?.mode === "existing" &&
          typeof saved.selector === "string" &&
          entries.some(
            (entry) =>
              entry.selector === saved.selector && entry.path === saved.path,
          )
        )
          choice = { mode: "existing", selector: saved.selector };
        else if (
          saved?.mode === "new" &&
          typeof saved.source === "string" &&
          typeof saved.name === "string"
        )
          choice = { mode: "new", source: saved.source, name: saved.name };
        setLoaded({ key, entries, templates, choice });
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
      const valid =
        /^(?:@[a-zA-Z0-9][a-zA-Z0-9_+.-]*|[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*)$/.test(
          choice.source,
        ) &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(choice.name) &&
        choice.name.length <= 80;
      onChange(
        valid
          ? { status: "ready", value: choice }
          : {
              status: "blocked",
              reason:
                "Choose a source and a lowercase, hyphenated workspace name.",
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
    <div className="space-y-2">
      <select
        aria-label="Workforest mode"
        value={choice.mode}
        onChange={(event) =>
          choose(
            event.target.value === "existing"
              ? { mode: "existing", selector: "" }
              : { mode: "new", source: "", name: "" },
          )
        }
      >
        <option value="existing">Use existing checkout</option>
        <option value="new">Create new workspace</option>
      </select>
      {choice.mode === "existing" ? (
        <>
          <select
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
          <label>
            Source
            <input
              aria-label="Workforest source"
              list="workforest-sources"
              value={choice.source}
              placeholder="@template or owner/repository"
              onChange={(event) =>
                choose({ ...choice, source: event.target.value })
              }
            />
          </label>
          <datalist id="workforest-sources">
            {current.templates.map((template) => (
              <option key={template.id} value={`@${template.id}`} />
            ))}
          </datalist>
          <input
            aria-label="Workspace name"
            value={choice.name}
            placeholder="workspace name"
            maxLength={80}
            onChange={(event) =>
              choose({ ...choice, name: event.target.value })
            }
          />
        </>
      )}
    </div>
  );
}
