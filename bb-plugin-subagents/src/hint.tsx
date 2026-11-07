// The one place a tooltip is made: BB does not show `title` attributes, so
// every hint goes through the vendored tooltip.
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.js";

export function Hint({ label, children, side = "top", disabled = false }: {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  /** The control already says it; no tooltip repeats it. */
  disabled?: boolean;
}) {
  if (disabled) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
