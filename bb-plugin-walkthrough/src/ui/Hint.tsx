// The one place a tooltip is made: BB does not show `title` attributes, so
// every hint goes through the vendored tooltip.
import { useContext, type ReactNode } from "react";
import { BoundaryContext } from "./context.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function Hint({ label, children, side = "top" }: { label: string; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  const boundary = useContext(BoundaryContext);
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={6} collisionPadding={8} collisionBoundary={boundary} className="wt-portal wt-tip">{label}</TooltipContent>
    </Tooltip>
  );
}
