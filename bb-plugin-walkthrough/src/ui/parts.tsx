import type { ReactNode } from "react";
import { experimental_FileLink as FileLink } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { formatLocation, summaryDetail, summaryTitle } from "../model.ts";
import { fileTarget, type FileContext } from "../files.ts";
import type { WalkthroughSummary } from "../rpc.ts";
import type { Location } from "../schemas.ts";

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
  if (target === null) return <code className={cn("wt-loc", className)}>{label}</code>;
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
      className={cn("wt-loc", className)}
    >
      {label}
    </FileLink>
  );
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("wt-muted", className)}>{children}</p>;
}

/**
 * One row of a walkthrough list: its title, then status, progress, and start
 * time so walkthroughs with the same title can be told apart. The SDK offers
 * no way to build a link to a nav panel or thread panel, so the row is a button.
 */
export function SummaryRow({ summary, onOpen }: { summary: WalkthroughSummary; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="wt-summary-row">
      <span className="wt-summary-title">{summaryTitle(summary)}</span>
      <span className="wt-muted">{summaryDetail(summary)}</span>
    </button>
  );
}
