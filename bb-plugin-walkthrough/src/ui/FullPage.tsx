// The Walkthrough nav panel: a walkthrough as a full page of the BB window
// instead of a thread side panel, plus an index of recent walkthroughs at its
// root.
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { PAGE_PATH } from "../schemas.ts";
import { useRecentWalkthroughs, useWalkthrough } from "./hooks.ts";
import { Muted, SummaryRow } from "./parts.tsx";
import { Reader } from "./Pane.tsx";

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
  if (!loaded) return <Muted className="p-6">{error ?? "Opening the walkthrough…"}</Muted>;
  if (view === null) return <Muted className="p-6">This walkthrough no longer exists.</Muted>;
  return <Reader threadId={view.walkthrough.threadId} view={view} rpc={rpc} surface="page" />;
}

function Index() {
  const navigate = useBbNavigate();
  const { walkthroughs, error } = useRecentWalkthroughs();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[40rem] space-y-4 px-6 py-8">
        <div>
          <h2 className="font-serif text-2xl font-medium">Recent walkthroughs</h2>
          <p className="mt-1 text-sm text-muted-foreground">Start one from a thread’s side panel, and open it as a full page from the button in its header.</p>
        </div>
        {walkthroughs === null ? (
          <Muted>{error ?? "Loading…"}</Muted>
        ) : walkthroughs.length === 0 ? (
          <Muted>No walkthroughs yet.</Muted>
        ) : (
          <ul className="space-y-2.5">
            {walkthroughs.map((walkthrough) => (
              <li key={walkthrough.id}>
                <SummaryRow summary={walkthrough} onOpen={() => navigate.toPluginPanel(PAGE_PATH, { subPath: walkthrough.id })} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
