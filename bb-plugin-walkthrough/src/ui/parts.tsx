import { forwardRef, type ReactNode } from "react";
import { experimental_FileLink as FileLink } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatLocation, summaryDetail, summaryTitle } from "../model.ts";
import { fileTarget, type FileContext } from "../files.ts";
import type { WalkthroughSummary } from "../rpc.ts";
import type { Location } from "../schemas.ts";
import { Hint } from "./Hint.tsx";

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
  if (target === null) return <code className={cn("wt-loc", className)}><bdi>{label}</bdi></code>;
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
      <bdi>{label}</bdi>
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
 * With `onDelete` the row ends in a Delete button that takes no room until the
 * row is hovered or holds focus; it is a sibling of the row's button, not inside it.
 */
export const SummaryRow = forwardRef<HTMLButtonElement, { summary: WalkthroughSummary; onOpen: () => void; onDelete?: () => void }>(function SummaryRow({ summary, onOpen, onDelete }, ref) {
  const title = summaryTitle(summary);
  return (
    <div className="wt-summary-item">
      <button ref={ref} type="button" onClick={onOpen} className="wt-summary-row">
        <span className="wt-summary-title">{title}</span>
        <span className="wt-muted">{summaryDetail(summary)}</span>
      </button>
      {onDelete ? (
        <Hint label="Delete walkthrough" side="left">
          <button
            type="button"
            className="wt-summary-delete"
            aria-label={`Delete ${title}`}
            // The row is never dragged, but the guideline holds for every hover-revealed button.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onDelete}
          >
            <Icon name="Trash2" className="size-3.5" aria-hidden />
          </button>
        </Hint>
      ) : null}
    </div>
  );
});
