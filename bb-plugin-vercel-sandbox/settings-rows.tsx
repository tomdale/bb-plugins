import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Layout primitives that mirror BB's declarative plugin settings form, so the
// Account section reads as a continuation of the host-rendered Configuration
// card above it: the same recessed panel, label and description column,
// container-query breakpoint, and 11rem dropdown column.

/** The recessed panel that holds a group of setting rows. */
export const SETTINGS_PANEL_CLASS =
  "space-y-4 rounded-md border border-border bg-surface-recessed/70 px-3 py-3";

/** A dropdown trigger sized like the host's settings inputs. */
export const SETTINGS_TRIGGER_CLASS =
  "h-7 w-full min-w-0 justify-between border-border/60 bg-card px-2 text-xs font-normal";

/** Dropdown content at least as wide as its trigger. */
export const SETTINGS_MENU_CLASS =
  "min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-80";

/**
 * One setting: label and description on the left, the control in a fixed
 * column on the right. Narrow containers stack the control below the label,
 * as the host form does.
 */
export function SettingRow({
  label,
  labelId,
  description,
  children,
}: {
  label: string;
  /** Id for the label, so a control can name itself with it. */
  labelId?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="@container/settings w-full min-w-0">
      <div className="flex flex-col gap-2.5 @min-[36rem]/settings:flex-row @min-[36rem]/settings:items-start @min-[36rem]/settings:justify-between @min-[36rem]/settings:gap-5">
        <div className="min-w-0 flex-1">
          <p id={labelId} className="text-sm text-foreground">
            {label}
          </p>
          {description === undefined ? null : (
            <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
              {description}
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 @min-[36rem]/settings:w-44 @min-[36rem]/settings:shrink-0">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * A read-only value in a setting's control column, padded so its text lines
 * up with the text inside neighboring dropdown triggers.
 */
export function StaticValue({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-h-7 min-w-0 items-center px-[9px] text-xs text-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
