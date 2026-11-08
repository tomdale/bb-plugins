import { useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
  ThreadChat,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadTabProps, JsonValue } from "@get-bb/plugin-sdk/app";
import { Button } from "../components/ui/button.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { cn } from "../lib/utils.js";
import { useRuns } from "./hooks.ts";
import type { Run } from "./contracts.ts";
import {
  buildRunTrees,
  extractOneSentenceSummary,
  formatModelDisplayName,
  reasoningLevelLabel,
  runIsWorking,
  runStateNote,
  runStatusGlyph,
  runStatusLabel,
  splitModelLabelTag,
  stripModelBrandPrefix,
  type RunTreeNode,
} from "./status.ts";

/** A run's age relative to `now`, as "12s", "12m", "3h", or "2d". */
function relativeAge(createdAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function summaryForRun(run: Run): string {
  if (run.statusSummary.trim()) return run.statusSummary;
  return extractOneSentenceSummary(run.output || run.error || run.task, run.title);
}

type ProviderDirectory = ReturnType<typeof useProviders>["providers"];
type CatalogModelLabels = ReadonlyMap<string, string>;

/**
 * Resolves model display names from BB's execution-options catalog when available,
 * so routes like "vercel-ai-gateway/openai/gpt-6.1-sol" use their declared
 * displayName ("GPT-6.1 Sol") alongside the slug formatter fallback.
 */
function useCatalogModelLabels(runs: readonly Run[], environmentId?: string | null): CatalogModelLabels {
  const sdk = useSdk();
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(() => new Map());
  const pairsKey = useMemo(() => {
    const pairs = new Set<string>();
    for (const run of runs) {
      if (run.providerId) pairs.add(`${run.providerId}\0${run.model ?? ""}`);
    }
    return [...pairs].sort().join("\n");
  }, [runs]);
  useEffect(() => {
    const executionOptions = sdk?.system?.executionOptions;
    if (!pairsKey || typeof executionOptions !== "function") return;
    let current = true;
    void Promise.all(
      pairsKey.split("\n").map(async pair => {
        const [providerId, selectedModel] = pair.split("\0");
        if (!providerId) return null;
        try {
          return await executionOptions({
            providerId,
            ...(environmentId ? { environmentId } : {}),
            ...(selectedModel ? { selectedModel } : {}),
          });
        } catch {
          return null;
        }
      }),
    ).then(results => {
      if (!current) return;
      const next = new Map<string, string>();
      for (const result of results) {
        if (!result) continue;
        for (const entry of [...(result.models ?? []), ...(result.selectedOnlyModels ?? [])]) {
          if (entry.displayName) {
            next.set(entry.model, entry.displayName);
            const suffix = entry.model.split("/").pop();
            if (suffix && !next.has(suffix)) next.set(suffix, entry.displayName);
          }
        }
      }
      setLabels(next);
    });
    return () => {
      current = false;
    };
  }, [environmentId, pairsKey, sdk]);
  return labels;
}

/**
 * Standard BB provider icon + model display name + reasoning level line,
 * matching BB's `ModelReasoningPicker` trigger presentation.
 */
function RunExecutionSummary({
  run,
  providers,
  catalogLabels,
  padded,
}: {
  run: Run;
  providers: ProviderDirectory;
  catalogLabels: CatalogModelLabels;
  padded?: boolean;
}) {
  const providerId = run.providerId ?? "pi";
  const provider = providers.find(entry => entry.id === providerId);
  const brandPrefix = provider?.strings?.brandPrefix;
  const catalogName =
    (run.model ? catalogLabels.get(run.model) ?? catalogLabels.get(run.model.split("/").pop() ?? "") : undefined) ??
    undefined;
  const modelLabel = catalogName
    ? stripModelBrandPrefix(catalogName, brandPrefix)
    : formatModelDisplayName(run.model, brandPrefix);
  const { base: modelBase, tag: modelTag } = splitModelLabelTag(modelLabel);
  const reasoning = reasoningLevelLabel(run.reasoningLevel, provider?.reasoningLevels);

  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs leading-tight text-muted-foreground",
        padded && "mt-0.5 pl-[22px]",
      )}
    >
      <ProviderIcon
        providerKind="agent"
        provider={provider ?? { id: providerId }}
        className="size-4 shrink-0"
      />
      <span className="min-w-0 truncate">{modelBase}</span>
      {modelTag ? <span className="shrink-0 text-subtle-foreground">{modelTag}</span> : null}
      {reasoning ? <span className="shrink-0 text-subtle-foreground">{reasoning}</span> : null}
    </span>
  );
}

function RunTree({
  node,
  providers,
  catalogLabels,
  onSelect,
}: {
  node: RunTreeNode;
  providers: ProviderDirectory;
  catalogLabels: CatalogModelLabels;
  onSelect: (id: string) => void;
}) {
  const { run, children } = node;
  const active = runIsWorking(run);
  const note = runStateNote(run);
  const age = relativeAge(run.createdAt);
  const statusText = runStatusLabel(run);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-run-id={run.id}
        aria-label={`${run.title}, ${statusText}, ${age}`}
        onClick={() => onSelect(run.id)}
        className={cn(
          "flex w-full flex-col gap-1 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-state-hover focus-visible:border-border focus-visible:bg-state-hover focus-visible:outline-none",
          !active && "text-muted-foreground",
        )}
      >
        <span className="flex w-full items-center gap-2 text-[13px] leading-4">
          <span aria-hidden="true" className="w-3.5 shrink-0 text-center font-mono text-xs">
            {runStatusGlyph(run)}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{run.title}</span>
          {note && <span className="shrink-0 text-xs leading-4 text-muted-foreground">{note}</span>}
          <span className="min-w-[26px] shrink-0 text-right text-xs leading-4 tabular-nums text-muted-foreground">
            {age}
          </span>
        </span>
        <span className="pl-[22px] text-xs leading-[17px] text-muted-foreground [text-wrap:pretty]">
          {summaryForRun(run)}
        </span>
        <RunExecutionSummary
          run={run}
          providers={providers}
          catalogLabels={catalogLabels}
          padded
        />
      </button>
      {children.length > 0 && (
        <div className="ml-[15px] flex flex-col gap-1 border-l border-border pl-2.5">
          {children.map(child => (
            <RunTree
              key={child.run.id}
              node={child}
              providers={providers}
              catalogLabels={catalogLabels}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SubagentsPanel({
  threadId,
  environment,
}: ExperimentalThreadTabProps & { params: JsonValue | null }) {
  const { runs, error, report, rpc, refresh } = useRuns(threadId);
  const { providers } = useProviders();
  const catalogLabels = useCatalogModelLabels(runs, environment?.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [pendingFocus, setPendingFocus] = useState<"detail" | "list" | null>(null);
  const [busy, setBusy] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const navigate = useBbNavigate();

  useEffect(() => {
    setSelectedId(null);
    setLastSelectedId(null);
    setPendingFocus(null);
  }, [threadId]);

  const { activeTrees, inactiveTrees, parentById, childrenById } = useMemo(
    () => buildRunTrees(runs),
    [runs],
  );

  const selected = useMemo(
    () => (selectedId !== null ? runs.find(run => run.id === selectedId) : undefined),
    [runs, selectedId],
  );

  useEffect(() => {
    if (pendingFocus === "detail" && selected) {
      backButtonRef.current?.focus();
      setPendingFocus(null);
    } else if (pendingFocus === "list" && !selected && lastSelectedId) {
      sectionRef.current
        ?.querySelector<HTMLButtonElement>(`button[data-run-id="${lastSelectedId}"]`)
        ?.focus();
      setPendingFocus(null);
    }
  }, [pendingFocus, selected, lastSelectedId]);

  const selectRun = (id: string) => {
    setSelectedId(id);
    setLastSelectedId(id);
    setPendingFocus("detail");
  };

  const returnToList = () => {
    setSelectedId(null);
    setPendingFocus("list");
  };

  const parentRun = selected ? parentById.get(selected.id) : undefined;
  const childRuns = selected ? (childrenById.get(selected.id) ?? []) : [];

  return (
    <section ref={sectionRef} className="flex h-full min-h-0 flex-col" aria-label="Subagents">
      {error && (
        <p
          role="alert"
          className="m-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      {!selected ? (
        runs.length === 0 ? (
          <div
            role="status"
            className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground"
          >
            No subagent runs yet.
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3.5 p-2">
              {activeTrees.length > 0 && (
                <div role="group" aria-label="Active subagents" className="flex flex-col gap-1">
                  <div className="px-2 pt-0.5 pb-1 text-[11px] leading-3.5 font-medium tracking-[0.06em] text-muted-foreground uppercase">
                    Active
                  </div>
                  {activeTrees.map(node => (
                    <RunTree
                      key={node.run.id}
                      node={node}
                      providers={providers}
                      catalogLabels={catalogLabels}
                      onSelect={selectRun}
                    />
                  ))}
                </div>
              )}
              {inactiveTrees.length > 0 && (
                <div role="group" aria-label="Inactive subagents" className="flex flex-col gap-1">
                  <div className="px-2 pt-0.5 pb-1 text-[11px] leading-3.5 font-medium tracking-[0.06em] text-muted-foreground uppercase">
                    Inactive
                  </div>
                  {inactiveTrees.map(node => (
                    <RunTree
                      key={node.run.id}
                      node={node}
                      providers={providers}
                      catalogLabels={catalogLabels}
                      onSelect={selectRun}
                    />
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
        )
      ) : (
        <>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2.5 py-2">
            <Button ref={backButtonRef} type="button" variant="outline" size="sm" onClick={returnToList}>
              ← Subagents
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !selected.threadId}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await rpc.call("detach", { id: selected.id });
                  navigate.toThread(result.threadId);
                  refresh();
                } catch (cause) {
                  report(cause);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Detach subagent
            </Button>
          </div>
          <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2.5">
            {parentRun && (
              <button
                type="button"
                aria-label={`Parent subagent: ${parentRun.title}`}
                onClick={() => selectRun(parentRun.id)}
                className="inline-flex items-center gap-1 self-start text-xs leading-4 text-muted-foreground hover:text-foreground hover:underline"
              >
                <span aria-hidden="true">↳</span>
                <span>{parentRun.title}</span>
              </button>
            )}
            <div className="text-[13px] leading-[18px] font-semibold text-foreground [text-wrap:balance]">
              {selected.title}
            </div>
            <div className="text-xs leading-[17px] text-muted-foreground [text-wrap:pretty]">
              {summaryForRun(selected)}
            </div>
            <div className="flex items-center justify-between gap-2 text-xs leading-4 tabular-nums text-muted-foreground">
              <span>
                <span aria-hidden="true">{runStatusGlyph(selected)}</span> {runStatusLabel(selected)}
              </span>
              <span>{relativeAge(selected.createdAt)}</span>
            </div>
            <RunExecutionSummary
              run={selected}
              providers={providers}
              catalogLabels={catalogLabels}
            />
            {childRuns.length > 0 && (
              <div
                role="group"
                aria-label="Spawned subagents"
                className="mt-0.5 ml-1.5 flex flex-col gap-0.5 border-l border-border pl-2.5"
              >
                {childRuns.map(child => (
                  <button
                    key={child.id}
                    type="button"
                    onClick={() => selectRun(child.id)}
                    className="flex items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left text-xs leading-4 text-muted-foreground hover:bg-state-hover hover:text-foreground"
                  >
                    <span className="min-w-0 truncate">
                      <span aria-hidden="true">{runStatusGlyph(child)}</span> {child.title}
                    </span>
                    <span className="shrink-0 tabular-nums">{relativeAge(child.createdAt)}</span>
                  </button>
                ))}
              </div>
            )}
            {selected.error && (
              <div
                role="alert"
                className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs leading-4 text-destructive"
              >
                {selected.error}
              </div>
            )}
          </div>
          {selected.threadId ? (
            <ThreadChat
              key={selected.threadId}
              threadId={selected.threadId}
              variant="timeline"
              className="min-h-0 flex-1"
            />
          ) : (
            <div
              role="status"
              className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground"
            >
              Starting worker thread…
            </div>
          )}
        </>
      )}
    </section>
  );
}
