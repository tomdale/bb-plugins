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
import { cn } from "@/lib/utils";
import type { DetectedTarget } from "../detect-target.ts";
import { summaryDetail, summaryTitle, tabTitle } from "../model.ts";

export { tabTitle };
import type { WalkthroughSummary } from "../rpc.ts";
import { PANEL_ACTION_ID } from "../schemas.ts";
import { errorMessage, useThreadWalkthroughs } from "./hooks.ts";
import { markOpened, wasOpened } from "./opened.ts";
import { SummaryRow } from "./parts.tsx";

export function openPane(navigate: ReturnType<typeof useBbNavigate>, walkthroughId: string, title: string): boolean {
  return navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title, params: { walkthroughId } });
}

const isActive = (summary: WalkthroughSummary) => summary.status === "planning" || summary.status === "reading" || summary.status === "wrapping-up";
/** How long after its last change a walkthrough still counts as live for a client that has just arrived. */
export const LIVE_FOR_MS = 6 * 60 * 60 * 1000;
/** How long a finished walkthrough stays on the starter's Continue card. */
export const RECENT_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * The walkthrough the starter should lead back to: the newest one still in
 * progress, else the newest one finished within a day. Null when there is none
 * (or only older ones, which the list below still offers).
 */
export function continuable(walkthroughs: WalkthroughSummary[], now: number = Date.now()): WalkthroughSummary | null {
  const touched = (summary: WalkthroughSummary) => summary.updatedAt ?? summary.createdAt;
  const newest = (list: WalkthroughSummary[]) => list.reduce<WalkthroughSummary | null>((best, summary) => (best === null || summary.createdAt > best.createdAt ? summary : best), null);
  return newest(walkthroughs.filter(isActive)) ?? newest(walkthroughs.filter((summary) => summary.status === "done" && now - touched(summary) < RECENT_FOR_MS));
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
/** The in-progress walkthrough a client that has just arrived should be taken to, if it has not been opened here yet. */
export function toAutoOpen(walkthroughs: WalkthroughSummary[], pluginId: string, now: number = Date.now()): WalkthroughSummary | null {
  const live = walkthroughs.filter((summary) => isActive(summary) && now - (summary.updatedAt ?? summary.createdAt) < LIVE_FOR_MS && !wasOpened(`${pluginId}:opened:${summary.id}`));
  return live.reduce<WalkthroughSummary | null>((best, summary) => (best === null || summary.createdAt > best.createdAt ? summary : best), null);
}

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
      // Before the thread's automatic opener can see this walkthrough in a list: this tab already shows it.
      markOpened(`${pluginId}:opened:${walkthroughId}`);
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
  const resume = continuable(walkthroughs);
  const earlierOnes = walkthroughs.filter((walkthrough) => walkthrough.id !== resume?.id);
  // A walkthrough is under way: "No changes found" would read as the headline of a failed start, so it only speaks when nothing else does.
  const showFound = target !== null || resume === null;
  return (
    <div className="wt wt-starter">
      <header className="wt-top wt-glass">
        <h1 className="wt-title">Walkthrough</h1>
        <span className="wt-sp" />
        <span className="wt-start-count">{walkthroughs.length === 0 ? "New" : `${walkthroughs.length} earlier`}</span>
      </header>
      <div className="wt-scroll">
        <div className="wt-page wt-start-page">
          {resume ? (
            <section className="wt-continue" aria-label="Continue">
              <p className="wt-lbl">{resume.status === "done" ? "Finished recently" : "In progress"}</p>
              <h2 className="wt-continue-title">{summaryTitle(resume)}</h2>
              <p className="wt-muted">{summaryDetail(resume)}</p>
              <button type="button" className="wt-btn wt-btn-primary" onClick={() => onOpen(resume.id)}>
                {resume.status === "done" ? "Open it" : "Continue"}
              </button>
            </section>
          ) : null}
          <header className="wt-head">
            <h2>{resume ? "Start another walkthrough" : "Start a walkthrough"}</h2>
          </header>
          {showFound ? (
            <section className="wt-detected" aria-label="What was found">
              <Icon name={found.icon} className="size-4" aria-hidden />
              <div>
                <p className="wt-detected-t">{found.title}</p>
                {found.note ? <p className="wt-muted">{found.note}</p> : null}
              </div>
            </section>
          ) : null}
          <form
            className="wt-start-form"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <label className="wt-start-field">
              <span className="wt-start-label">Focus (optional)</span>
              <span className="wt-input wt-input-box wt-start-input">
                <input value={focus} onChange={(event) => setFocus(event.target.value)} aria-label="Focus" placeholder="What should it concentrate on?" />
              </span>
            </label>
            <button type="submit" className={cn("wt-btn", resume ? "wt-btn-quiet" : "wt-btn-primary")} disabled={starting || target === undefined}>
              {starting ? "Starting…" : pullRequest ? "Walk me through this PR" : "Walk me through it"}
            </button>
          </form>
          {earlierOnes.length > 0 ? (
            <section className="wt-earlier" aria-label="Earlier walkthroughs">
              <h3 className="wt-lbl">Earlier walkthroughs</h3>
              <ul>
                {earlierOnes.map((walkthrough) => (
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

/**
 * Opens a tab for the thread's live walkthrough as soon as a client views the
 * thread, even when the walkthrough began while no client was looking (or on
 * another device): the header action mounts with the thread, so it sees the
 * list as it loads and on every change.
 */
export function WalkthroughAutoOpener({ threadId }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const pluginId = usePluginId();
  const { values } = useSettings();
  const autoOpen = values?.autoOpenPanel !== false;
  const { walkthroughs } = useThreadWalkthroughs(threadId);
  useEffect(() => {
    if (!autoOpen || startingThreads.has(threadId)) return;
    const walkthrough = toAutoOpen(walkthroughs, pluginId);
    if (walkthrough === null) return;
    // Marked only once the host accepts the tab: a thread with no side panel (a narrow window) is tried again on the next change.
    if (openPane(navigate, walkthrough.id, tabTitle(walkthrough.title))) markOpened(`${pluginId}:opened:${walkthrough.id}`);
  }, [autoOpen, navigate, pluginId, threadId, walkthroughs]);
  return null;
}
