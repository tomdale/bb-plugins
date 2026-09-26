import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Icon } from "../components/ui/icon.js";
import type { Entry } from "../contracts.js";
import {
  needsAttention,
  relativeUpdated,
  type groupInventory,
} from "./inventory-model.js";
import { State } from "./shared.js";

type Group = ReturnType<typeof groupInventory>[number];
const PREVIEW_COUNT = 5;
export function InventoryGroup({
  group,
  selected,
  onSelect,
  showAll,
}: {
  group: Group;
  selected: string;
  onSelect: (entry: Entry) => void;
  showAll: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const selectionIndex = group.entries.findIndex(
    (entry) => entry.selector === selected,
  );
  const limit =
    expanded || showAll
      ? group.entries.length
      : Math.max(PREVIEW_COUNT, selectionIndex + 1);
  const visible = group.entries.slice(0, limit);
  const exceptions = group.entries.filter(needsAttention).length;
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <h2>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.name}`}
          className="flex w-full items-center gap-2 bg-muted/30 px-3 py-2.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Icon
            name="GitBranch"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span
            className="min-w-0 flex-1 truncate text-sm font-semibold"
            title={group.name}
          >
            {group.name}
          </span>
          {exceptions > 0 && (
            <span
              className="text-xs text-destructive"
              title={`${exceptions} checkouts need attention`}
            >
              {exceptions} to check
            </span>
          )}
          <span className="text-xs tabular-nums text-muted-foreground">
            {group.entries.length}
          </span>
          <span aria-hidden="true" className="text-xs text-muted-foreground">
            {collapsed ? "+" : "−"}
          </span>
        </button>
      </h2>
      {!collapsed && (
        <>
          <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[11px] text-muted-foreground">
            <span>
              {group.kind === "Repository" ? "Worktrees" : "Workspaces"}
            </span>
            <span title="Workforest metadata update time, not last commit or agent activity">
              Updated
            </span>
          </div>
          <ul className="divide-y divide-border/50">
            {visible.map((entry) => (
              <li key={entry.selector}>
                <button
                  type="button"
                  aria-pressed={selected === entry.selector}
                  aria-label={`Open ${entry.selector}`}
                  onClick={() => onSelect(entry)}
                  className={`group flex min-h-10 w-full items-center gap-3 border-l-2 px-3 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selected === entry.selector ? "border-l-primary bg-accent" : "border-l-transparent"}`}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-sm"
                      title={entry.changeName}
                    >
                      {entry.changeName}
                    </span>
                    {entry.type !== "worktree" && (
                      <span
                        className="mt-0.5 block truncate text-xs text-muted-foreground"
                        title={entry.repos?.join(", ")}
                      >
                        {entry.repos?.join(" · ")}
                      </span>
                    )}
                  </span>
                  {needsAttention(entry) && <State value={entry.state} />}
                  <time
                    dateTime={new Date(entry.modifiedAtMs).toISOString()}
                    title={new Date(entry.modifiedAtMs).toLocaleString()}
                    className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                  >
                    {relativeUpdated(entry.modifiedAtMs)}
                  </time>
                </button>
              </li>
            ))}
          </ul>
          {!showAll && group.entries.length > PREVIEW_COUNT && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start rounded-none border-t border-border px-3 text-muted-foreground"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? "Show fewer"
                : limit < group.entries.length
                  ? `Show ${group.entries.length - limit} more`
                  : "Show all"}{" "}
              <span className="sr-only">in {group.name}</span>
            </Button>
          )}
        </>
      )}
    </section>
  );
}
