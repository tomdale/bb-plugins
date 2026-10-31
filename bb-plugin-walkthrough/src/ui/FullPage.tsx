// The Walkthrough nav panel: a walkthrough as a full page of the BB window
// instead of a thread side panel, plus an index of recent walkthroughs at its
// root.
import { useRef, useState } from "react";
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { TooltipProvider } from "@/components/ui/tooltip";
import { summaryTitle } from "../model.ts";
import { PAGE_PATH } from "../schemas.ts";
import { DeletedPage, DeleteWalkthroughDialog, type DeleteTarget } from "./DeleteWalkthrough.tsx";
import { useRecentWalkthroughs, useWalkthrough, useWalkthroughRpc } from "./hooks.ts";
import { Muted, SummaryRow } from "./parts.tsx";
import { LoadingPage } from "./Pane.tsx";
import { Reader } from "./Reader.tsx";

/** The walkthrough id is the first segment of the route after the panel path. */
export function walkthroughIdFromSubPath(subPath: string): string | null {
  const [id] = subPath.split("/").filter((segment) => segment.length > 0);
  return id ?? null;
}

export function WalkthroughFullPage({ subPath }: PluginNavPanelProps) {
  const walkthroughId = walkthroughIdFromSubPath(subPath);
  return walkthroughId === null ? <Index /> : <Page walkthroughId={walkthroughId} />;
}

function Page({ walkthroughId }: { walkthroughId: string }) {
  const { view, loaded, error, rpc } = useWalkthrough(walkthroughId);
  if (!loaded) return <LoadingPage message={error} />;
  if (view === null) return <DeletedPage />;
  return <Reader threadId={view.walkthrough.threadId} view={view} rpc={rpc} surface="page" />;
}

function Index() {
  const navigate = useBbNavigate();
  const rpc = useWalkthroughRpc();
  const { walkthroughs, error } = useRecentWalkthroughs();
  // `target` outlives the dialog so its text holds while it closes; `open` is separate.
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  const [open, setOpen] = useState(false);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  // Focus lands on the row that takes the deleted one's place, else the one above, else the heading.
  const neighbor = useRef<string | null>(null);
  const askToDelete = (id: string, title: string) => {
    const list = walkthroughs ?? [];
    const at = list.findIndex((walkthrough) => walkthrough.id === id);
    neighbor.current = list[at + 1]?.id ?? list[at - 1]?.id ?? null;
    setTarget({ id, title });
    setOpen(true);
  };
  return (
    <TooltipProvider>
      <div className="wt wt-surface-page flex-1">
        <div className="wt-scroll">
          <div className="wt-page wt-index">
            <header className="wt-head">
              <h2 ref={heading} tabIndex={-1}>
                Recent walkthroughs
              </h2>
            </header>
            {walkthroughs === null ? (
              <Muted>{error ?? "Loading…"}</Muted>
            ) : walkthroughs.length === 0 ? (
              <Muted>No walkthroughs yet. Start one from a thread’s side panel.</Muted>
            ) : (
              <ul className="wt-index-list">
                {walkthroughs.map((walkthrough) => (
                  <li key={walkthrough.id}>
                    <SummaryRow
                      ref={(element) => {
                        if (element) rows.current.set(walkthrough.id, element);
                        else rows.current.delete(walkthrough.id);
                      }}
                      summary={walkthrough}
                      onOpen={() => navigate.toPluginPanel(PAGE_PATH, { subPath: walkthrough.id })}
                      onDelete={() => askToDelete(walkthrough.id, summaryTitle(walkthrough))}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      <DeleteWalkthroughDialog
        target={target}
        open={open}
        onOpenChange={setOpen}
        rpc={rpc}
        restoreFocus={() => {
          const next = neighbor.current ? rows.current.get(neighbor.current) : undefined;
          (next ?? heading.current)?.focus();
        }}
      />
    </TooltipProvider>
  );
}
