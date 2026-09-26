import {
  useBbNavigate,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Icon } from "../components/ui/icon.js";
import { Input } from "../components/ui/input.js";
import type { Bootstrap, Job, rpcContract } from "../contracts.js";
import { useResource } from "../hooks/use-resource.js";
import { CreateDialog } from "./dialogs.js";
import {
  Empty,
  ErrorMessage,
  State,
  muted,
  parseRoute,
  pathFor,
  selectClass,
} from "./shared.js";
import { WorkspaceDetail } from "./workspace.js";
import { InventoryGroup } from "./inventory-list.js";
import {
  groupInventory,
  needsAttention,
  type InventoryFilter,
  type InventorySort,
} from "./inventory-model.js";
export function WorkforestPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const bootstrap = useResource(
    "bootstrap",
    () => rpc.call("bootstrap"),
    30000,
  );
  const route = parseRoute(subPath);
  const hostId =
    route.hostId ||
    bootstrap.data?.hosts.find((host) => host.status === "connected")?.id ||
    "";
  const [create, setCreate] = useState(false);
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Checkouts</h1>
            <p className={muted}>
              Browse by repository or workspace. Select a change to work on it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              className={selectClass}
              aria-label="Machine"
              value={hostId}
              onChange={(event) =>
                navigate.toPluginPanel("workspaces", {
                  subPath: pathFor(event.target.value),
                })
              }
            >
              {!hostId && <option value="">Choose a machine</option>}
              {bootstrap.data?.hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                  {host.status !== "connected" ? " · offline" : ""}
                </option>
              ))}
            </select>
            <Button
              disabled={
                !hostId ||
                bootstrap.data?.hosts.find((host) => host.id === hostId)
                  ?.status !== "connected"
              }
              onClick={() => setCreate(true)}
            >
              <Icon name="Plus" className="size-4" />
              New workspace
            </Button>
          </div>
        </div>
        <ErrorMessage message={bootstrap.error} />
        {!bootstrap.data ? (
          <Empty>Loading machines…</Empty>
        ) : !hostId ? (
          <Empty>
            Connect a BB machine with Workforest installed to get started.
          </Empty>
        ) : (
          <Browser
            key={hostId}
            hostId={hostId}
            selected={route.selector}
            bootstrap={bootstrap.data}
          />
        )}
        {create && hostId && (
          <CreateDialog hostId={hostId} close={() => setCreate(false)} />
        )}
      </div>
    </div>
  );
}

export function Browser({
  hostId,
  selected,
  bootstrap,
}: {
  hostId: string;
  selected: string;
  bootstrap: Bootstrap;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const inventory = useResource(`inventory:${hostId}`, () =>
    rpc.call("inventory", { hostId }),
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<InventoryFilter>("all");
  const [sort, setSort] = useState<InventorySort>("recent");
  const entries = [
    ...(inventory.data?.workspaces ?? []),
    ...(inventory.data?.repositories ?? []),
  ];
  const groups = groupInventory(entries, query, filter, sort);
  const matchingCount = groups.reduce(
    (count, group) => count + group.entries.length,
    0,
  );
  const tabs: { value: InventoryFilter; label: string; count: number }[] = [
    { value: "all", label: "All", count: entries.length },
    {
      value: "workspaces",
      label: "Workspaces",
      count: inventory.data?.workspaces.length ?? 0,
    },
    {
      value: "worktrees",
      label: "Worktrees",
      count: inventory.data?.repositories.length ?? 0,
    },
    {
      value: "attention",
      label: "Needs attention",
      count: entries.filter(needsAttention).length,
    },
  ];
  const clearSelection = () =>
    navigate.toPluginPanel("workspaces", { subPath: pathFor(hostId) });
  return (
    <>
      <ErrorMessage message={inventory.error} />
      <Jobs hostId={hostId} />
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label="Filter checkouts"
        >
          {tabs.map((tab) => (
            <Button
              key={tab.value}
              size="sm"
              variant={filter === tab.value ? "secondary" : "ghost"}
              aria-pressed={filter === tab.value}
              onClick={() => setFilter(tab.value)}
            >
              {tab.label}
              <span className="ml-1 text-xs tabular-nums text-muted-foreground">
                {inventory.data ? tab.count : "–"}
              </span>
            </Button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground" role="status">
          {inventory.data
            ? `${matchingCount} checkouts · ${groups.length} groups`
            : "Loading inventory…"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-48 flex-1"
          value={query}
          name="workforest-search"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search changes, repositories, or paths…"
          aria-label="Search Workforest"
        />
        <select
          className={selectClass}
          value={sort}
          onChange={(event) => setSort(event.target.value as InventorySort)}
          aria-label="Sort groups"
        >
          <option value="recent">Recently updated</option>
          <option value="name">Name A–Z</option>
        </select>
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh inventory"
          onClick={inventory.refresh}
        >
          <Icon name="RotateCcw" className="size-4" />
        </Button>
      </div>
      {filter === "attention" && (
        <p className="text-xs text-muted-foreground">
          Workforest entries not marked ready. This is setup / inventory state,
          not uncommitted Git changes.
        </p>
      )}
      <div
        className={
          selected
            ? "grid items-start gap-4 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.3fr)]"
            : ""
        }
      >
        <div className={selected ? "hidden space-y-3 lg:block" : ""}>
          {!inventory.data ? (
            <Empty>
              {inventory.error
                ? "Inventory unavailable. Check the error above and refresh."
                : "Reading Workforest inventory…"}
            </Empty>
          ) : !groups.length ? (
            <Empty>
              {query
                ? "No matching checkouts."
                : filter === "attention"
                  ? "All checkouts are ready."
                  : filter !== "all"
                    ? "No checkouts in this category."
                    : "No checkouts yet. Create a workspace or worktree above."}
              {(query || filter !== "all") && (
                <div className="mt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              )}
            </Empty>
          ) : (
            <div
              className={
                selected
                  ? "space-y-3"
                  : "grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3"
              }
            >
              {groups.map((group) => (
                <InventoryGroup
                  key={group.id}
                  group={group}
                  selected={selected}
                  showAll={Boolean(query.trim()) || filter === "attention"}
                  onSelect={(entry) =>
                    navigate.toPluginPanel("workspaces", {
                      subPath: pathFor(hostId, entry.selector),
                    })
                  }
                />
              ))}
            </div>
          )}
        </div>
        {selected && (
          <div className="min-w-0 lg:sticky lg:top-4">
            <div className="mb-2 flex justify-between gap-2">
              <Button size="sm" variant="ghost" onClick={clearSelection}>
                Back to overview
              </Button>
              <span className="self-center text-xs text-muted-foreground">
                Checkout details
              </span>
            </div>
            <WorkspaceDetail
              key={`${hostId}:${selected}`}
              hostId={hostId}
              selector={selected}
              bootstrap={bootstrap}
            />
          </div>
        )}
      </div>
      {!selected && inventory.data && (
        <p className="text-xs text-muted-foreground">
          Showing up to 5 changes per group. “Updated” reflects Workforest
          metadata, not agent activity or the last commit.
        </p>
      )}
    </>
  );
}

export function Jobs({ hostId }: { hostId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const jobs = useResource(
    `jobs:${hostId}`,
    () => rpc.call("jobs", { hostId }),
    3000,
  );
  return (
    <>
      <ErrorMessage message={jobs.error} />
      {jobs.data && jobs.data.length > 0 && (
        <details
          className="rounded-lg border border-border bg-card p-3"
          open={jobs.data.some((job) => job.state === "running")}
        >
          <summary className="cursor-pointer text-sm font-medium">
            Operations ·{" "}
            {jobs.data.filter((job) => job.state === "running").length} running
          </summary>
          <div className="mt-3 space-y-2">
            {jobs.data.slice(0, 8).map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
            <p className="text-xs text-muted-foreground">
              Recent operations are session-only. Workforest status and setup
              logs remain the source of truth. Creation can finish before
              background setup is ready.
            </p>
          </div>
        </details>
      )}
    </>
  );
}
export function JobRow({ job }: { job: Job }) {
  return (
    <details className="rounded-md bg-muted/40 p-2">
      <summary className="cursor-pointer text-sm">
        <State value={job.state} /> <span className="ml-2">{job.label}</span>
      </summary>
      {job.output && (
        <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs">
          {job.output}
        </pre>
      )}
    </details>
  );
}
