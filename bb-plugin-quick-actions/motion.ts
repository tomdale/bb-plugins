import type { CSSProperties } from "react";

export const ACTION_STAGGER_MS = 12;
export const MENU_RADIUS_PX = 116;
/** Outer radius of the hold-Option pie's black disc. */
export const PIE_RADIUS_PX = 132;
/** Where each slice's icon and label sit, between the hub and the rim. */
export const PIE_ITEM_RADIUS_PX = 86;
/** Pointer travel from the centre before a slice counts as selected. */
export const PIE_DEAD_ZONE_PX = 24;

export const CORNERS = [
  "bottom-left",
  "bottom-right",
  "top-left",
  "top-right",
] as const;
export type Corner = (typeof CORNERS)[number];

export const MOTIONS = ["ring", "arc"] as const;
export type QuickActionMotion = (typeof MOTIONS)[number];

export const TRIGGERS = ["hold-option", "corner"] as const;
export type QuickActionTrigger = (typeof TRIGGERS)[number];

export function sanitizeCorner(value: unknown): Corner {
  return CORNERS.find((corner) => corner === value) ?? "bottom-left";
}

export function sanitizeMotion(value: unknown): QuickActionMotion {
  return MOTIONS.find((motion) => motion === value) ?? "ring";
}

export function sanitizeTrigger(value: unknown): QuickActionTrigger {
  return TRIGGERS.find((trigger) => trigger === value) ?? "hold-option";
}

/**
 * Radial slots around the pointer, evenly spaced and starting at twelve
 * o'clock, so the pie reads the same wherever it opens.
 */
export function cursorActionTarget(
  index: number,
  count: number,
): { x: number; y: number } {
  const step = (Math.PI * 2) / Math.max(1, count);
  const angle = -Math.PI / 2 + step * index;
  return {
    x: Math.cos(angle) * PIE_ITEM_RADIUS_PX,
    y: Math.sin(angle) * PIE_ITEM_RADIUS_PX,
  };
}

/**
 * The slice the pointer points into, measured from the pie centre. Inside the
 * dead zone nothing is selected, so the pie opens with no slice lit.
 */
export function pieSliceAt(
  offset: { x: number; y: number },
  count: number,
): number | null {
  if (count < 1 || Math.hypot(offset.x, offset.y) < PIE_DEAD_ZONE_PX) {
    return null;
  }
  const step = (Math.PI * 2) / count;
  // Clockwise angle from twelve o'clock, matching cursorActionTarget.
  const angle = Math.atan2(offset.x, -offset.y);
  return ((Math.round(angle / step) % count) + count) % count;
}

/**
 * SVG path of one slice pointing at twelve o'clock, from the centre out to the
 * rim. The highlighted slice is this path rotated to the selected slot.
 */
export function pieSlicePath(count: number): string {
  const r = PIE_RADIUS_PX;
  if (count <= 1) {
    return `M 0 ${-r} A ${r} ${r} 0 1 1 0 ${r} A ${r} ${r} 0 1 1 0 ${-r} Z`;
  }
  const half = Math.PI / count;
  const x = (Math.sin(half) * r).toFixed(2);
  const y = (-Math.cos(half) * r).toFixed(2);
  return `M 0 0 L -${x} ${y} A ${r} ${r} 0 0 1 ${x} ${y} Z`;
}

/**
 * Keeps the whole pie inside the window: near an edge the pie centre moves in
 * far enough that no slice is clipped offscreen.
 */
export function clampMenuOrigin(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const inset = PIE_RADIUS_PX + 8;
  const clamp = (value: number, extent: number) =>
    Math.min(Math.max(value, inset), Math.max(inset, extent - inset));
  return { x: clamp(point.x, viewport.width), y: clamp(point.y, viewport.height) };
}

export function actionTarget(
  index: number,
  count: number,
  corner: Corner,
): { x: number; y: number } {
  const start = -8;
  const span = count <= 2 ? 55 : 88;
  const angle =
    ((start - (span * index) / Math.max(1, count - 1)) * Math.PI) / 180;
  let x = Math.cos(angle) * MENU_RADIUS_PX;
  let y = Math.sin(angle) * MENU_RADIUS_PX;
  if (corner.endsWith("right")) x = -x;
  if (corner.startsWith("top")) y = -y;
  return { x, y };
}

export function actionCssVariables({
  index,
  count,
  corner,
}: {
  index: number;
  count: number;
  corner: Corner;
}): CSSProperties {
  const target = actionTarget(index, count, corner);
  return {
    "--qa-action-x": `${target.x}px`,
    "--qa-action-y": `${target.y}px`,
    "--qa-open-delay": `${index * ACTION_STAGGER_MS}ms`,
  } as CSSProperties;
}

export function cursorActionCssVariables({
  index,
  count,
}: {
  index: number;
  count: number;
}): CSSProperties {
  const target = cursorActionTarget(index, count);
  return {
    "--qa-action-x": `${target.x}px`,
    "--qa-action-y": `${target.y}px`,
    "--qa-open-delay": `${index * ACTION_STAGGER_MS}ms`,
  } as CSSProperties;
}

export function hoverCorridorPoints(target: { x: number; y: number }): string {
  const distance = Math.hypot(target.x, target.y);
  const ux = target.x / distance;
  const uy = target.y / distance;
  const start = 16;
  const halfWidth = 16;
  const startX = ux * start;
  const startY = uy * start;
  const perpX = -uy * halfWidth;
  const perpY = ux * halfWidth;
  return [
    [startX + perpX, startY + perpY],
    [target.x + perpX, target.y + perpY],
    [target.x - perpX, target.y - perpY],
    [startX - perpX, startY - perpY],
  ]
    .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ");
}
