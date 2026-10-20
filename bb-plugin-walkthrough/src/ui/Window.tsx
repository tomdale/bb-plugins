// The Walkthrough nav panel: a walkthrough as a page of its own, which is what
// the pop-out window loads, plus an index of recent walkthroughs at its root.
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { WalkthroughSummary } from "../rpc.ts";
import { PAGE_PATH } from "../schemas.ts";
import { useRecentWalkthroughs, useWalkthrough } from "./hooks.ts";
import { Muted } from "./parts.tsx";
import { Reader } from "./Pane.tsx";

/** The walkthrough id is the first segment of the route after the panel path. */
export function walkthroughIdFromSubPath(subPath: string): string | null {
  const [id] = subPath.split("/").filter((segment) => segment.length > 0);
  return id ?? null;
}

export function WalkthroughWindow({ subPath }: PluginNavPanelProps) {
  const walkthroughId = walkthroughIdFromSubPath(subPath);
  return walkthroughId === null ? <Index /> : <Page walkthroughId={walkthroughId} />;
}

function Page({ walkthroughId }: { walkthroughId: string }) {
  const { view, loaded, error, rpc } = useWalkthrough(walkthroughId);
  if (!loaded) return <Muted className="p-6">{error ?? "Opening the walkthrough…"}</Muted>;
  if (view === null) return <Muted className="p-6">This walkthrough no longer exists.</Muted>;
  return <Reader threadId={view.walkthrough.threadId} view={view} rpc={rpc} surface="page" />;
}

function label(walkthrough: WalkthroughSummary): string {
  return walkthrough.title === "Walkthrough" ? walkthrough.request || walkthrough.title : walkthrough.title;
}

function Index() {
  const navigate = useBbNavigate();
  const { walkthroughs, error } = useRecentWalkthroughs();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[40rem] space-y-4 px-6 py-8">
        <div>
          <h2 className="font-serif text-2xl font-medium">Recent walkthroughs</h2>
          <p className="mt-1 text-sm text-muted-foreground">Start one from a thread’s side panel, and open it in its own window from the button in its header.</p>
        </div>
        {walkthroughs === null ? (
          <Muted>{error ?? "Loading…"}</Muted>
        ) : walkthroughs.length === 0 ? (
          <Muted>No walkthroughs yet.</Muted>
        ) : (
          <ul className="space-y-1">
            {walkthroughs.map((walkthrough) => (
              <li key={walkthrough.id}>
                <button
                  type="button"
                  onClick={() => navigate.toPluginPanel(PAGE_PATH, { subPath: walkthrough.id })}
                  className="flex w-full items-baseline gap-2 text-left text-sm hover:underline"
                >
                  <span className="min-w-0 truncate">{label(walkthrough)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{walkthrough.status === "done" ? "finished" : walkthrough.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
