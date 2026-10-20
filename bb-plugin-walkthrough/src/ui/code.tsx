// A code excerpt inside the reading view: a plain caption, the change shown
// three ways (change / after / before), and margin notes beside it.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { experimental_Diff as Diff } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { defaultExcerptView, excerptCode, type ExcerptView } from "../model.ts";
import type { ExcerptResult } from "../rpc.ts";
import type { CodeBlock, Walkthrough } from "../schemas.ts";
import { errorMessage, useWalkthroughRpc } from "./hooks.ts";
import { LocationLink } from "./parts.tsx";

type View = ExcerptView;
const VIEWS: View[] = ["change", "after", "before"];

/** The first element under `root`, shadow roots included, that scrolls sideways. */
function findHorizontalScroller(root: ParentNode): HTMLElement | null {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    if (element.scrollWidth > element.clientWidth + 1 && /auto|scroll/u.test(getComputedStyle(element).overflowX)) return element;
    const nested = element.shadowRoot ? findHorizontalScroller(element.shadowRoot) : null;
    if (nested) return nested;
  }
  return null;
}

export function CodeExcerpt({ walkthrough, block, wide }: { walkthrough: Walkthrough; block: CodeBlock; wide: boolean }) {
  const rpc = useWalkthroughRpc();
  const [result, setResult] = useState<ExcerptResult | null>(null);
  // Until the reader picks a view, the excerpt opens in whichever suits its content.
  const [chosenView, setView] = useState<View | null>(null);
  useEffect(() => {
    let live = true;
    setResult(null);
    rpc
      .call("excerpt", { walkthroughId: walkthrough.id, path: block.path, startLine: block.startLine, endLine: block.endLine })
      .then(
        (next) => live && setResult(next),
        (cause: unknown) => live && setResult({ outcome: "unavailable", message: errorMessage(cause) }),
      );
    return () => {
      live = false;
    };
  }, [rpc, walkthrough.id, walkthrough.baseRef, block.path, block.startLine, block.endLine]);

  const available = result?.outcome === "available" ? result : null;
  const patchFor = (candidate: View) => (available ? available[candidate] : null);
  const view = chosenView ?? (available ? defaultExcerptView(available) : "change");
  const effectiveView = patchFor(view) ? view : (VIEWS.find((candidate) => patchFor(candidate)) ?? view);
  const patch = patchFor(effectiveView);
  const notes = block.notes;
  const [expanded, setExpanded] = useState(false);
  const lineCount = patch ? patch.split("\n").filter((line) => /^[ +-]/u.test(line) && !/^(\+\+\+|---) /u.test(line)).length : 0;
  const long = lineCount > 30;
  const scrollerRef = useRef<HTMLDivElement>(null);
  // The host's diff viewer owns the horizontal scroller (and it is not a tab stop),
  // so the focusable wrapper scrolls it on the arrow keys.
  const scrollSideways = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const scroller = scrollerRef.current ? findHorizontalScroller(scrollerRef.current) : null;
    if (!scroller) return;
    event.preventDefault();
    scroller.scrollBy({ left: event.key === "ArrowLeft" ? -80 : 80 });
  };
  const copy = () => {
    if (!patch) return;
    void navigator.clipboard.writeText(excerptCode(patch, effectiveView)).then(
      () => toast.success("Copied the code"),
      () => toast.error("Could not copy"),
    );
  };

  return (
    <figure
      data-code-path={block.path}
      data-code-start={block.startLine}
      data-code-end={block.endLine}
      className={cn("my-5 grid gap-x-4 gap-y-2", wide && notes.length > 0 ? "grid-cols-[minmax(0,1fr)_11rem]" : "grid-cols-1")}
    >
      <figcaption className="col-span-full flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-serif text-[13.5px] text-foreground">{block.caption}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <LocationLink
            files={walkthrough}
            location={{ path: block.path, startLine: block.startLine, endLine: block.endLine }}
            className="min-w-0 break-all text-muted-foreground"
          />
          <span role="group" aria-label="Show the code as" className="flex shrink-0 overflow-hidden rounded-md border border-border">
            {VIEWS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                disabled={!patchFor(candidate)}
                title={patchFor(candidate) ? undefined : result === null ? undefined : `The ${candidate} view is not available for this excerpt`}
                aria-pressed={effectiveView === candidate}
                onClick={() => setView(candidate)}
                className={cn(
                  "px-2 py-0.5 text-[11px] disabled:opacity-40",
                  effectiveView === candidate ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {candidate}
              </button>
            ))}
          </span>
          <button
            type="button"
            aria-label="Copy the code"
            title="Copy the code"
            disabled={!patch}
            onClick={copy}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <Icon name="Copy" className="size-3.5" aria-hidden />
          </button>
        </span>
      </figcaption>
      <div className="min-w-0 overflow-hidden rounded-md border border-border">
        {result === null ? (
          <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
            Loading the code…
          </p>
        ) : patch ? (
          <div
            ref={scrollerRef}
            tabIndex={0}
            role="region"
            aria-label={`Code from ${block.path}, lines ${block.startLine} to ${block.endLine}`}
            onKeyDown={scrollSideways}
            className={cn("relative focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", long && !expanded && "max-h-[28rem] overflow-hidden")}
          >
            <Diff patch={patch} path={available?.path ?? block.path} />
            {long && !expanded ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="absolute inset-x-0 bottom-0 border-t border-border bg-card/95 px-3 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
              >
                Show all {lineCount} lines
              </button>
            ) : null}
          </div>
        ) : (
          <p className="px-3 py-2 text-xs text-muted-foreground">{result.outcome === "unavailable" ? result.message : "Nothing to show."}</p>
        )}
      </div>
      {notes.length > 0 ? (
        <aside className={cn("space-y-3 font-serif text-[12.5px] leading-snug text-muted-foreground", !wide && "pl-1")}>
          {notes.map((note, index) => (
            <p key={index}>
              <span className="mr-1 font-sans text-[11px] text-foreground/70">{note.line ? `Line ${note.line}` : "Note"}</span>
              {note.text}
            </p>
          ))}
        </aside>
      ) : null}
    </figure>
  );
}
