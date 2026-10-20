import { useEffect, useState, type ReactNode } from "react";
import { experimental_Diff as Diff, experimental_FileLink as FileLink } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatLocation, shortRef, summaryDetail, summaryTitle } from "../model.ts";
import { fileTarget, type FileContext } from "../files.ts";
import type { DiffResult, WalkthroughSummary } from "../rpc.ts";
import type { Location, Walkthrough } from "../schemas.ts";
import { errorMessage, useWalkthroughRpc } from "./hooks.ts";

/** A live file reference, routed to its workspace or explicit host. */
export function LocationLink({
  files,
  location,
  className,
}: {
  files: FileContext;
  location: Location;
  className?: string;
}) {
  const label = formatLocation(location) ?? location.path;
  const target = fileTarget(files, location.path);
  if (target === null) return <code className={cn("text-xs", className)}>{label}</code>;
  const fileLocation =
    location.startLine === undefined
      ? null
      : location.endLine === undefined || location.endLine === location.startLine
        ? ({ kind: "line", line: location.startLine, column: null } as const)
        : ({ kind: "range", startLine: location.startLine, endLine: location.endLine } as const);
  return (
    <FileLink
      target={target}
      location={fileLocation}
      className={cn("font-mono text-xs underline-offset-2 hover:underline", className)}
    >
      {label}
    </FileLink>
  );
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>;
}

/**
 * One row of a walkthrough list: its title, then status, progress, and start
 * time so walkthroughs with the same title can be told apart. The SDK offers
 * no way to build a link to a nav panel or thread panel, so the row is a button.
 */
export function SummaryRow({ summary, onOpen }: { summary: WalkthroughSummary; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group block w-full text-left">
      <span className="block truncate text-sm group-hover:underline">{summaryTitle(summary)}</span>
      <span className="block text-xs text-muted-foreground">{summaryDetail(summary)}</span>
    </button>
  );
}

const COLLAPSE_AFTER_LINES = 24;

/** The base-to-head change for one file, narrowed to a line range when given. */
export function DiffView({
  walkthrough,
  location,
  withFullFile = false,
}: {
  walkthrough: Walkthrough;
  location: Location;
  withFullFile?: boolean;
}) {
  const rpc = useWalkthroughRpc();
  const [result, setResult] = useState<DiffResult | null>(null);
  const { path, startLine, endLine } = location;
  const [expanded, setExpanded] = useState(false);
  const changedLines =
    result?.outcome === "available" ? result.patch.split("\n").filter((line) => /^[ +-]/u.test(line) && !/^(\+\+\+|---) /u.test(line)).length : 0;
  const long = changedLines > COLLAPSE_AFTER_LINES;
  useEffect(() => {
    let live = true;
    setResult(null);
    rpc
      .call("diff", {
        walkthroughId: walkthrough.id,
        path,
        ...(startLine === undefined ? {} : { startLine }),
        ...(endLine === undefined ? {} : { endLine }),
        withFullFile,
      })
      .then(
        (next) => {
          if (live) setResult(next);
        },
        (cause: unknown) => {
          if (live) setResult({ outcome: "unavailable", message: errorMessage(cause) });
        },
      );
    return () => {
      live = false;
    };
  }, [rpc, walkthrough.id, path, startLine, endLine, withFullFile, walkthrough.baseRef]);

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <Icon name="FileDiff" className="size-3.5 text-muted-foreground" aria-hidden />
        <LocationLink files={walkthrough} location={location} />
        <span className="ml-auto text-xs text-muted-foreground" title={walkthrough.baseRef}>
          vs {shortRef(walkthrough.baseRef)}
        </span>
      </div>
      {result === null ? (
        <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
          Loading diff…
        </p>
      ) : result.outcome === "unavailable" ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{result.message}</p>
      ) : (
        <>
          <div className={cn("relative", long && !expanded && "max-h-[26rem] overflow-hidden")}>
            <Diff
              patch={result.patch}
              path={result.path}
              {...(result.fullFileContents ? { experimental_fullFileContents: result.fullFileContents } : {})}
            />
            {long && !expanded ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent" />
            ) : null}
          </div>
          {long ? (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              className="w-full border-t border-border px-3 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
            >
              {expanded ? "Collapse" : `Show all ${changedLines} lines`}
            </button>
          ) : null}
          {result.filtered || result.truncated ? (
            <p className="border-t border-border px-3 py-1 text-xs text-muted-foreground">
              {result.truncated ? "Patch truncated. " : ""}
              {result.filtered ? "Showing hunks in the referenced lines." : ""}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
