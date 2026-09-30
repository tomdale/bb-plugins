// Small surfaces around the thread: the header progress chip and the chat
// directives the agent embeds in its narration.
import { useCallback } from "react";
import {
  experimental_usePluginId as usePluginId,
  useBbNavigate,
  useSettings,
  type PluginMessageDirectiveProps,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { PANEL_ACTION_ID, locationSchema, type Walkthrough } from "../schemas.ts";
import { useWalkthrough } from "./hooks.ts";
import { DiffView, GroupStatusIcon, Muted } from "./parts.tsx";

function progressLabel(walkthrough: Walkthrough): string {
  const total = walkthrough.groups.length;
  if (walkthrough.status === "overview") return `Outline · ${total} groups`;
  if (walkthrough.status === "reviewing" && walkthrough.currentGroup !== null) return `${walkthrough.currentGroup + 1}/${total}`;
  if (walkthrough.status === "finishing") return "Finishing";
  return "Finished";
}

/** Opens the panel once per walkthrough per window when one starts. */
function useAutoOpenPanel(): (walkthroughId: string) => void {
  const navigate = useBbNavigate();
  const pluginId = usePluginId();
  const { values } = useSettings();
  const enabled = values?.autoOpenPanel !== false;
  return useCallback(
    (walkthroughId: string) => {
      if (!enabled) return;
      const key = `${pluginId}:opened:${walkthroughId}`;
      try {
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, "1");
      } catch {
        // Storage can be unavailable; opening twice is harmless.
      }
      navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: "Walkthrough" });
    },
    [enabled, navigate, pluginId],
  );
}

export function HeaderChip({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const autoOpen = useAutoOpenPanel();
  const { view } = useWalkthrough(threadId, autoOpen);
  const navigate = useBbNavigate();
  if (view === null || view.walkthrough.status === "finished") return null;
  const { walkthrough, notes } = view;
  const open = notes.filter((note) => note.status === "open").length;
  const label = progressLabel(walkthrough);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      aria-label={`Walkthrough: ${label}, ${open} open notes. Open the Walkthrough panel.`}
      onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: "Walkthrough" })}
    >
      <Icon name="Explore" className="size-4" aria-hidden />
      {isCompactViewport ? null : <span>{label}</span>}
      {open > 0 ? <span className="rounded-full bg-secondary px-1.5 text-secondary-foreground">{open}</span> : null}
    </Button>
  );
}

/** `::walkthrough-outline` — the live outline with progress. */
export function OutlineDirective({ message }: PluginMessageDirectiveProps) {
  const { view, loaded } = useWalkthrough(message.threadId);
  const navigate = useBbNavigate();
  if (!loaded) return null;
  if (view === null) return <Muted>No walkthrough in this thread.</Muted>;
  const { walkthrough, notes } = view;
  return (
    <div className="my-2 rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <Icon name="Explore" className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{walkthrough.title}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: "Walkthrough" })}
        >
          Open panel
        </Button>
      </div>
      <ol className="space-y-1">
        {walkthrough.groups.map((group, index) => {
          const count = notes.filter((note) => note.groupIndex === index && note.status === "open").length;
          return (
            <li key={`${index}:${group.title}`} className="flex items-start gap-2 text-sm">
              <GroupStatusIcon status={group.status} />
              <span className={cn("min-w-0 flex-1", group.status === "current" && "font-medium")}>
                <span className="text-muted-foreground">{index + 1}.</span> {group.title}
                {group.summary ? <span className="block text-xs text-muted-foreground">{group.summary}</span> : null}
              </span>
              {count > 0 ? <span className="text-xs text-muted-foreground">{count} notes</span> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function parseLines(value: string | undefined): { startLine?: number; endLine?: number } | null {
  if (value === undefined || value.trim() === "") return {};
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/u.exec(value.trim());
  if (match === null) return null;
  const startLine = Number(match[1]);
  const endLine = match[2] === undefined ? startLine : Number(match[2]);
  return { startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine) };
}

/** `::walkthrough-diff{path="src/a.ts" lines="10-40"}` — the real change for a file range. */
export function DiffDirective({ attributes, source, message }: PluginMessageDirectiveProps) {
  const { view, loaded } = useWalkthrough(message.threadId);
  const lines = parseLines(attributes.lines);
  const location = lines === null ? null : locationSchema.safeParse({ path: attributes.path, ...lines });
  if (location === null || !location.success) return <code className="text-xs">{source}</code>;
  if (!loaded) return null;
  if (view === null) return <code className="text-xs">{source}</code>;
  return (
    <div className="my-2">
      <DiffView threadId={message.threadId} walkthrough={view.walkthrough} location={location.data} />
    </div>
  );
}
