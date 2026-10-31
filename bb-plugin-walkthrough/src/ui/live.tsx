// The pane before the first words arrive: what was asked, what was found in
// the working tree, and one live line naming what the helper is doing. The
// skeleton below them is only the shape of the page to come; these lines are
// what tells the reader the walkthrough is alive within the first second.
import type { Walkthrough } from "../schemas.ts";
import { Skeleton, workingLine } from "./Pages.tsx";

type Detected = NonNullable<Walkthrough["detected"]>;

/** "4 files · 2 staged, 1 unstaged · +40 −8", or null when nothing was found yet or the tree is clean. */
export function detectedLine(detected: Walkthrough["detected"]): string | null {
  if (detected === undefined || detected.files === 0) return null;
  const counts = ([["staged", detected.staged], ["unstaged", detected.unstaged], ["untracked", detected.untracked]] as const)
    .filter(([, count]) => count > 0)
    .map(([word, count]) => `${count} ${word}`);
  const lines = detected.additions + detected.deletions > 0 ? `+${detected.additions} \u2212${detected.deletions}` : null;
  return [`${detected.files} ${detected.files === 1 ? "file" : "files"}`, counts.join(", ") || null, lines].filter(Boolean).join(" \u00b7 ");
}

/** What the helper is doing, from what the record shows: never a forecast. */
export function liveLine(walkthrough: Pick<Walkthrough, "inFlight" | "workerThreadId">, steps: number | undefined): string {
  const working = workingLine(steps);
  if (working !== null) return working;
  return walkthrough.inFlight === null ? "Getting a helper ready\u2026" : "Reading the code\u2026";
}

export function PreparingLive({ walkthrough, steps }: { walkthrough: Walkthrough; steps?: number | undefined }) {
  const found = detectedLine(walkthrough.detected);
  return (
    <article aria-busy>
      <header className="wt-head">
        <p className="wt-lbl">You asked</p>
        <h2>{walkthrough.request || "The changes on this branch"}</h2>
      </header>
      {found ? (
        <p className="wt-found" data-testid="wt-found">
          <span className="wt-found-k">In the working tree</span> {found}
        </p>
      ) : null}
      <p className="wt-working wt-pulse" role="status" data-testid="wt-live">
        {liveLine(walkthrough, steps)}
      </p>
      <Skeleton label="Reading the change and deciding how to explain it…" />
    </article>
  );
}

export type { Detected };
