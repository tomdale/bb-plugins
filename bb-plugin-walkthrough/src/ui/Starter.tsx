// Starting a walkthrough from an empty pane, and the thread's automatic pane opener.
import { useEffect, useState } from "react";
import {
  experimental_usePluginId as usePluginId,
  useBbNavigate,
  useSettings,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import type { DetectedTarget } from "../detect-target.ts";
import { PANEL_ACTION_ID } from "../schemas.ts";
import { errorMessage, useThreadWalkthroughs } from "./hooks.ts";
import { SummaryRow } from "./parts.tsx";

export function openPane(navigate: ReturnType<typeof useBbNavigate>, walkthroughId: string, title: string): boolean {
  return navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title, params: { walkthroughId } });
}

/** How often an open starter looks again: the working tree changes while the pane sits there. */
export const DETECT_EVERY_MS = 4000;

/** Threads whose reader is being started by hand, so the automatic opener leaves them alone. */
const startingThreads = new Set<string>();

/**
 * What a manual start would cover: undefined while looking for the first time,
 * null when there is nothing to walk through. It looks again every few seconds
 * and when the window regains focus, keeping the last answer meanwhile.
 */
function useDetectedTarget(threadId: string, rpc: ReturnType<typeof useThreadWalkthroughs>["rpc"]): DetectedTarget | undefined {
  const [target, setTarget] = useState<DetectedTarget | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setTarget(undefined);
    const look = () =>
      rpc.call("detectTarget", { threadId }).then(
        (result) => live && setTarget(result.target),
        () => live && setTarget((current) => (current === undefined ? null : current)),
      );
    void look();
    const timer = setInterval(() => void look(), DETECT_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState !== "hidden") void look();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [rpc, threadId]);
  return target;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const counts = (target: { files: number; additions: number; deletions: number }) => `${plural(target.files, "file")}, +${target.additions} \u2212${target.deletions}`;

/** The starter's headline and a quieter line under it for what was found. */
export function describeTarget(target: DetectedTarget | undefined): { icon: string; title: string; note: string } {
  if (target === undefined) return { icon: "Explore", title: "Looking for changes\u2026", note: "" };
  if (target === null) return { icon: "Explore", title: "No changes found", note: "Say what to walk through, or start and the agent will look." };
  if (target.kind === "pr") return { icon: "GitPullRequest", title: `PR #${target.number} \u00b7 ${target.title}`, note: target.draft ? "A draft pull request on this branch" : "A pull request on this branch" };
  if (target.kind === "uncommitted") {
    // Staged, unstaged and untracked files can overlap, so each is reported on its own rather than as parts of the total.
    const where = [target.staged ? `${target.staged} staged` : null, target.unstaged ? `${target.unstaged} not staged` : null, target.untracked ? `${target.untracked} untracked` : null].filter(Boolean).join(" \u00b7 ");
    return { icon: "Explore", title: `Uncommitted changes \u00b7 ${counts(target)}`, note: where || "Changes in the working tree" };
  }
  return { icon: "Explore", title: `Branch changes \u00b7 ${counts(target)}`, note: target.branch && target.base ? `${target.branch} compared with ${target.base}` : "Compared with where the branch started" };
}

/** What the starter found, one button, an optional focus line, and earlier walkthroughs. */
export function Starter({ threadId, onOpen }: { threadId: string; /** Shows a walkthrough in this same tab. */ onOpen: (walkthroughId: string) => void }) {
  const pluginId = usePluginId();
  const { walkthroughs, rpc } = useThreadWalkthroughs(threadId);
  const target = useDetectedTarget(threadId, rpc);
  const found = describeTarget(target);
  const [focus, setFocus] = useState("");
  const [starting, setStarting] = useState(false);
  const pullRequest = target?.kind === "pr" ? target : null;
  const start = async () => {
    setStarting(true);
    startingThreads.add(threadId);
    try {
      const request = focus.trim() || (pullRequest ? "This PR, for review" : "");
      const { walkthroughId } = await rpc.call("start", { threadId, request });
      try {
        sessionStorage.setItem(`${pluginId}:opened:${walkthroughId}`, "1");
      } catch {
        // Ignore unavailable storage.
      }
      // The walkthrough takes this tab over: a thread panel tab cannot be replaced, and a second tab would leave this one behind.
      onOpen(walkthroughId);
      setFocus("");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      startingThreads.delete(threadId);
      setStarting(false);
    }
  };
  return (
    <div className="wt wt-starter">
      <header className="wt-top wt-glass">
        <h1 className="wt-title">Walkthrough</h1>
        <span className="wt-sp" />
        <span className="wt-start-count">{walkthroughs.length === 0 ? "New" : `${walkthroughs.length} earlier`}</span>
      </header>
      <div className="wt-scroll">
        <div className="wt-page wt-start-page">
          <div className="wt-pn" aria-hidden>
            PART<b>·</b>
          </div>
          <header className="wt-head">
            <h2>Start a walkthrough</h2>
          </header>
          <section className="wt-detected" aria-label="What was found">
            <Icon name={found.icon} className="size-4" aria-hidden />
            <div>
              <p className="wt-detected-t">{found.title}</p>
              {found.note ? <p className="wt-muted">{found.note}</p> : null}
            </div>
          </section>
          <form
            className="wt-start-form"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <span className="wt-start-label" aria-hidden>
              Focus (optional)
            </span>
            <label className="wt-input wt-input-box wt-start-input">
              <input value={focus} onChange={(event) => setFocus(event.target.value)} aria-label="Focus" placeholder="What should it concentrate on?" />
            </label>
            <button type="submit" className="wt-btn wt-btn-primary" disabled={starting || target === undefined}>
              {starting ? "Starting…" : pullRequest ? "Walk me through this PR" : "Walk me through it"}
            </button>
          </form>
          {walkthroughs.length > 0 ? (
            <section className="wt-earlier" aria-label="Earlier walkthroughs">
              <h3 className="wt-lbl">Earlier walkthroughs</h3>
              <ul>
                {walkthroughs.map((walkthrough) => (
                  <li key={walkthrough.id}>
                    <SummaryRow summary={walkthrough} onOpen={() => onOpen(walkthrough.id)} />
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
    if (!autoOpen || startingThreads.has(threadId)) return;
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
