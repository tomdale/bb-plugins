// The Walkthrough nav panel: a walkthrough as a full page of the BB window
// instead of a thread side panel, plus an index of recent walkthroughs at its
// root.
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { PAGE_PATH } from "../schemas.ts";
import { useRecentWalkthroughs, useWalkthrough } from "./hooks.ts";
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
  if (view === null) return <LoadingPage message="This walkthrough no longer exists." />;
  return <Reader threadId={view.walkthrough.threadId} view={view} rpc={rpc} surface="page" />;
}

function Index() {
  const navigate = useBbNavigate();
  const { walkthroughs, error } = useRecentWalkthroughs();
  return (
    <div className="wt wt-surface-page flex-1">
      <div className="wt-scroll">
        <div className="wt-page wt-index">
          <header className="wt-head">
            <h2>Recent walkthroughs</h2>
          </header>
          {walkthroughs === null ? (
            <Muted>{error ?? "Loading…"}</Muted>
          ) : walkthroughs.length === 0 ? (
            <Muted>No walkthroughs yet. Start one from a thread’s side panel.</Muted>
          ) : (
            <ul className="wt-index-list">
              {walkthroughs.map((walkthrough) => (
                <li key={walkthrough.id}>
                  <SummaryRow summary={walkthrough} onOpen={() => navigate.toPluginPanel(PAGE_PATH, { subPath: walkthrough.id })} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
