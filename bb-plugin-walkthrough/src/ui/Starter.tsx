// Starting a walkthrough from an empty pane, and the thread's automatic pane opener.
import { useState } from "react";
import {
  experimental_usePluginId as usePluginId,
  experimental_useSidebarThreadPullRequest,
  useBbNavigate,
  useSettings,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { PANEL_ACTION_ID } from "../schemas.ts";
import { errorMessage, useThreadWalkthroughs } from "./hooks.ts";
import { SummaryRow } from "./parts.tsx";

export function openPane(navigate: ReturnType<typeof useBbNavigate>, walkthroughId: string, title: string): boolean {
  return navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title, params: { walkthroughId } });
}

/** The thread's pull request when the host can say; older hosts have no such lookup. */
function useDetectedPullRequest(threadId: string) {
  const lookup = typeof experimental_useSidebarThreadPullRequest === "function" ? experimental_useSidebarThreadPullRequest : null;
  // The lookup is fixed for the life of the host, so the hook order never changes.
  return lookup ? lookup(threadId).pullRequest : null;
}

/** What the starter found, one button, an optional focus line, and earlier walkthroughs. */
export function Starter({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const pluginId = usePluginId();
  const { walkthroughs, rpc } = useThreadWalkthroughs(threadId);
  const pullRequest = useDetectedPullRequest(threadId);
  const [focus, setFocus] = useState("");
  const [starting, setStarting] = useState(false);
  const reviewable = pullRequest !== null && pullRequest.state !== "draft";
  const start = async () => {
    setStarting(true);
    try {
      const request = focus.trim() || (pullRequest ? "This PR, for review" : "");
      const { walkthroughId } = await rpc.call("start", { threadId, request });
      try {
        sessionStorage.setItem(`${pluginId}:opened:${walkthroughId}`, "1");
      } catch {
        // Ignore unavailable storage.
      }
      openPane(navigate, walkthroughId, "Walkthrough");
      setFocus("");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setStarting(false);
    }
  };
  return (
    <div className="wt wt-starter">
      <div className="wt-scroll">
        <div className="wt-page wt-start-page">
          <div className="wt-pn" aria-hidden>
            PART<b>·</b>
          </div>
          <header className="wt-head">
            <h2>Start a walkthrough</h2>
          </header>
          <section className="wt-detected" aria-label="What was found">
            <Icon name={pullRequest ? "GitPullRequest" : "Explore"} className="size-4" aria-hidden />
            <div>
              <p className="wt-detected-t">{pullRequest ? `#${pullRequest.number} ${pullRequest.title}` : "Changes on this branch"}</p>
              <p className="wt-muted">{pullRequest ? (reviewable ? "A pull request on this branch" : "A draft pull request on this branch") : "Compared with where the branch started"}</p>
            </div>
          </section>
          <form
            className="wt-start-form"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <label className="wt-input wt-input-box">
              <input value={focus} onChange={(event) => setFocus(event.target.value)} aria-label="Focus" placeholder="Focus on… (optional)" />
            </label>
            <button type="submit" className="wt-btn wt-btn-primary" disabled={starting}>
              {starting ? "Starting…" : pullRequest ? "Walk me through this PR" : "Walk me through it"}
            </button>
          </form>
          {walkthroughs.length > 0 ? (
            <section className="wt-earlier" aria-label="Earlier walkthroughs">
              <h3 className="wt-lbl">Earlier walkthroughs</h3>
              <ul>
                {walkthroughs.map((walkthrough) => (
                  <li key={walkthrough.id}>
                    <SummaryRow summary={walkthrough} onOpen={() => openPane(navigate, walkthrough.id, walkthrough.title)} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function WalkthroughAutoOpener({ threadId }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const pluginId = usePluginId();
  const { values } = useSettings();
  const autoOpen = values?.autoOpenPanel !== false;
  useThreadWalkthroughs(threadId, (signal) => {
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
  return null;
}
