// The Walkthrough button in the thread header. With no walkthrough it opens
// a small starter; with one it opens (or reopens) its pane.
import { useState } from "react";
import { experimental_usePluginId as usePluginId, useBbNavigate, useSettings, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { PANEL_ACTION_ID } from "../schemas.ts";
import { errorMessage, useThreadWalkthroughs } from "./hooks.ts";

const STARTERS = ["The changes on this branch", "This PR, for review", "The code we've been talking about", "The changes you just made"];

export function openPane(navigate: ReturnType<typeof useBbNavigate>, walkthroughId: string, title: string): boolean {
  return navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title, params: { walkthroughId } });
}

/** Chips plus a request box; used by the header dialog and an empty pane. */
export function StartForm({ threadId, onStarted, autoFocus }: { threadId: string; onStarted?: () => void; autoFocus?: boolean }) {
  const navigate = useBbNavigate();
  const pluginId = usePluginId();
  const { rpc } = useThreadWalkthroughs(threadId);
  const [request, setRequest] = useState("");
  const [starting, setStarting] = useState(false);
  const start = async () => {
    setStarting(true);
    try {
      const { walkthroughId } = await rpc.call("start", { threadId, request });
      try {
        sessionStorage.setItem(`${pluginId}:opened:${walkthroughId}`, "1");
      } catch {
        // Ignore unavailable storage.
      }
      openPane(navigate, walkthroughId, "Walkthrough");
      setRequest("");
      onStarted?.();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setStarting(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {STARTERS.map((starter) => (
          <button key={starter} type="button" onClick={() => setRequest(starter)} className="rounded-full border border-border px-3 py-1 text-xs hover:bg-secondary">
            {starter}
          </button>
        ))}
      </div>
      <textarea
        value={request}
        autoFocus={autoFocus}
        onChange={(event) => setRequest(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void start();
        }}
        rows={3}
        aria-label="What should the walkthrough cover?"
        placeholder="What should it walk you through? Leave empty for the changes on this branch."
        className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground"
      />
      <div className="flex justify-end">
        <Button type="button" disabled={starting} onClick={() => void start()}>
          {starting ? "Starting…" : "Start"}
        </Button>
      </div>
    </div>
  );
}

export function WalkthroughButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const pluginId = usePluginId();
  const { values } = useSettings();
  const autoOpen = values?.autoOpenPanel !== false;
  const { walkthroughs, rpc } = useThreadWalkthroughs(threadId, (signal) => {
    if (!autoOpen) return;
    const key = `${pluginId}:opened:${signal.walkthroughId}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // Storage can be unavailable; opening twice is harmless.
    }
    openPane(navigate, signal.walkthroughId, "Walkthrough");
  });
  const [open, setOpen] = useState(false);
  const active = walkthroughs.find((walkthrough) => walkthrough.status !== "done" && walkthrough.status !== "failed") ?? null;

  const label = active
    ? active.status === "planning"
      ? "Getting ready"
      : active.status === "wrapping-up"
        ? "Wrapping up"
      : active.currentPart === null
        ? "Introduction"
        : `${active.currentPart + 1}/${active.partCount}`
    : "Walkthrough";

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        aria-label={active ? `Open the walkthrough: ${active.title}, ${label}` : "Start a walkthrough of this thread's changes"}
        onClick={() => (active ? openPane(navigate, active.id, active.title) : setOpen(true))}
      >
        <Icon name="Explore" className="size-4" aria-hidden />
        {isCompactViewport ? null : <span>{label}</span>}
        {active && active.openNotes > 0 ? <span className="rounded-full bg-secondary px-1.5 text-secondary-foreground">{active.openNotes}</span> : null}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start a walkthrough</DialogTitle>
            <DialogDescription>
              A helper agent that knows this conversation writes a walkthrough in a pane beside it. This thread keeps working as usual.
            </DialogDescription>
          </DialogHeader>
          <StartForm threadId={threadId} onStarted={() => setOpen(false)} autoFocus />
        </DialogContent>
      </Dialog>
    </>
  );
}
