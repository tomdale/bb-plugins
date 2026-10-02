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
import { Input } from "../components/ui/input.js";
import type { rpcContract } from "../contracts.js";
import { WORKFOREST_ENVIRONMENT_PROVIDER_ID } from "../provider-id.js";
import { selectRegisteredProject } from "./select-project.js";
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
export function openWorkforestProjectPicker(composer: PickerComposer) {
  setPickerComposer(composer);
}
export function WorkforestProjectOverlay() {
  const composer = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
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
    "composer-source-machines",
    () => rpc.call("bootstrap", null),
    0,
  );
  const [chosenHost, setChosenHost] = useState<string>();
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string>();
  const hosts =
    bootstrap.data?.hosts.filter((host) => host.status === "connected") ?? [];
  const environment = composer.selection?.environment;
  const preferred =
    environment?.type === "host"
      ? environment.hostId
      : environment?.type === "provider" &&
          environment.machine?.type === "existing"
        ? environment.machine.hostId
        : undefined;
  const hostId =
    chosenHost ??
    hosts.find((host) => host.id === preferred)?.id ??
    hosts[0]?.id;
  async function select(sourceId: string) {
    if (!hostId || progress || composer.isSubmitting) return;
    setProgress("Registering source project…");
    setError(undefined);
    try {
      const project = await rpc.call("sourceProject", { hostId, sourceId });
      setProgress("Selecting project and loading environment choices…");
      await selectRegisteredProject(
        (selection) => composer.setSelection(selection),
        {
          projectId: project.projectId,
          environment: {
            type: "provider",
            environmentProviderId: WORKFOREST_ENVIRONMENT_PROVIDER_ID,
            machine: { type: "existing", hostId },
            inputs: null,
          },
        },
      );
      close();
      composer.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProgress("");
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !progress) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Use Workforest source</DialogTitle>
          <DialogDescription>
            Select a template or repository. Then choose or create its workspace
            or worktree in the environment control. Your draft stays here;
            selecting a source creates no checkout or thread.
          </DialogDescription>
        </DialogHeader>
        <ErrorMessage message={bootstrap.error || error} />
        {progress && (
          <p role="status" aria-live="polite">
            {progress}
          </p>
        )}
        {!bootstrap.data ? (
          <Empty>Loading machines…</Empty>
        ) : !hosts.length ? (
          <Empty>No connected machines.</Empty>
        ) : (
          <>
            <label className="grid gap-2 text-sm">
              Machine
              <select
                className={selectClass}
                value={hostId}
                disabled={Boolean(progress)}
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
              <SourceList
                key={hostId}
                hostId={hostId}
                disabled={Boolean(progress) || composer.isSubmitting}
                select={select}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
function SourceList({
  hostId,
  disabled,
  select,
}: {
  hostId: string;
  disabled: boolean;
  select: (sourceId: string) => Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const sources = useResource(
    `sources:${hostId}`,
    () => rpc.call("sources", { hostId }),
    0,
  );
  const [query, setQuery] = useState("");
  const entries = sources.data
    ?.filter((source) =>
      `${source.name} ${source.source} ${source.description ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    );
  return (
    <div className="space-y-3" aria-busy={disabled}>
      <Input
        aria-label="Search Workforest sources"
        placeholder="Search templates or repositories…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ErrorMessage message={sources.error} />
      {sources.error && (
        <Button type="button" variant="outline" onClick={sources.refresh}>
          Retry loading sources
        </Button>
      )}
      {!sources.data && !sources.error ? (
        <p role="status">Loading templates and repositories…</p>
      ) : entries?.length === 0 ? (
        <Empty>No matching sources.</Empty>
      ) : (
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {entries?.map((source) => (
            <li key={source.id}>
              <button
                type="button"
                disabled={disabled || Boolean(sources.error)}
                aria-label={`Use ${source.kind} ${source.name}`}
                onClick={() => void select(source.id)}
                className="w-full rounded-md p-3 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <span className="block text-sm font-medium">{source.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {source.kind === "template" ? "Template" : "Repository"} ·{" "}
                  {source.description ?? source.source}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
