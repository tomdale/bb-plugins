import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

/**
 * A setting whose value is one of a fixed list, saved as soon as it is
 * picked. Shows `placeholder` and stays disabled until `value` is known.
 */
export function SettingSelect<T extends string | number>({
  label,
  description,
  value,
  options,
  placeholder = "Loading…",
  disabled = false,
  onChange,
  children,
}: {
  label: string;
  description?: ReactNode;
  value: T | null;
  options: readonly { value: T; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: T) => void;
  /** Messages shown under the control, such as a save failure. */
  children?: ReactNode;
}) {
  const labelId = useId();
  const selected = options.find((option) => option.value === value);
  return (
    <SettingRow label={label} labelId={labelId} description={description}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || selected === undefined}
            aria-labelledby={`${labelId} ${labelId}-value`}
            className={SETTINGS_TRIGGER_CLASS}
          >
            <span
              id={`${labelId}-value`}
              className={cn(
                "min-w-0 truncate",
                selected === undefined && "text-muted-foreground",
              )}
            >
              {selected?.label ?? placeholder}
            </span>
            <Icon
              name="ChevronDown"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          mobileTitle={label}
          aria-labelledby={labelId}
          className={SETTINGS_MENU_CLASS}
        >
          {options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              role="menuitemradio"
              aria-checked={option.value === value}
              onSelect={() => onChange(option.value)}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.value === value ? (
                <Icon name="Check" className="size-3.5" />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {children}
    </SettingRow>
  );
}
