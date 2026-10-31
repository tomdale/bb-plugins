// The one place a tooltip is made: BB does not show `title` attributes, so
// every hint goes through the vendored tooltip.
import { useContext, type ReactNode } from "react";
import { BoundaryContext } from "./context.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function Hint({ label, children, side = "top", disabled = false }: { label: string; children: ReactNode; side?: "top" | "bottom" | "left" | "right"; /** The control already says it; no tooltip repeats it. */ disabled?: boolean }) {
  const boundary = useContext(BoundaryContext);
  if (disabled) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={6} collisionPadding={8} collisionBoundary={boundary} className="wt-portal wt-tip">{label}</TooltipContent>
    </Tooltip>
  );
}
