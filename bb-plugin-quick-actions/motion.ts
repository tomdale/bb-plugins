import type { CSSProperties } from "react";

export const ACTION_STAGGER_MS = 12;
export const MENU_RADIUS_PX = 116;
/** Outer radius of the hold-Option pie's black disc. */
export const PIE_RADIUS_PX = 124;
/** Where each slice's icon and label sit once the pie has opened. */
export const PIE_ITEM_RADIUS_PX = 84;
/**
 * Where items start their fly-out: far enough out that an item at its opening
 * scale never overlaps the hub.
 */
export const PIE_ITEM_START_RADIUS_PX = 44;
/**
 * Radius of the visible hub, which is also the dead zone: with the pointer
 * inside it nothing is selected, and releasing Option there runs nothing.
 */
export const PIE_HUB_RADIUS_PX = 28;

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
  radius = PIE_ITEM_RADIUS_PX,
): { x: number; y: number } {
  const step = (Math.PI * 2) / Math.max(1, count);
  const angle = -Math.PI / 2 + step * index;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
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
  if (count < 1 || Math.hypot(offset.x, offset.y) < PIE_HUB_RADIUS_PX) {
    return null;
  }
  const step = (Math.PI * 2) / count;
  // Clockwise angle from twelve o'clock, matching cursorActionTarget.
  const angle = Math.atan2(offset.x, -offset.y);
  return ((Math.round(angle / step) % count) + count) % count;
}

/**
 * SVG path of one slice pointing at twelve o'clock: an annular sector from the
 * hub's edge out to the rim, so the lit slice reads as a pizza slice whose tip
 * is tucked under the hub. Each slot draws this path rotated to its angle.
 */
export function pieSlicePath(count: number): string {
  const outer = PIE_RADIUS_PX;
  const inner = PIE_HUB_RADIUS_PX;
  const f = (value: number) => value.toFixed(2);
  if (count <= 1) {
    return [
      `M 0 ${-outer} A ${outer} ${outer} 0 1 1 0 ${outer}`,
      `A ${outer} ${outer} 0 1 1 0 ${-outer}`,
      `M 0 ${-inner} A ${inner} ${inner} 0 1 0 0 ${inner}`,
      `A ${inner} ${inner} 0 1 0 0 ${-inner} Z`,
    ].join(" ");
  }
  const half = Math.PI / count;
  const ox = Math.sin(half) * outer;
  const oy = -Math.cos(half) * outer;
  const ix = Math.sin(half) * inner;
  const iy = -Math.cos(half) * inner;
  return `M ${f(-ix)} ${f(iy)} L ${f(-ox)} ${f(oy)} A ${outer} ${outer} 0 0 1 ${f(ox)} ${f(oy)} L ${f(ix)} ${f(iy)} A ${inner} ${inner} 0 0 0 ${f(-ix)} ${f(iy)} Z`;
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

/**
 * Per-item CSS for the pie: its resting slot, where its fly-out starts, and
 * stagger delays that run clockwise from twelve on open and in reverse on
 * close.
 */
export function cursorActionCssVariables({
  index,
  count,
}: {
  index: number;
  count: number;
}): CSSProperties {
  const target = cursorActionTarget(index, count);
  const start = cursorActionTarget(index, count, PIE_ITEM_START_RADIUS_PX);
  return {
    "--qa-action-x": `${target.x}px`,
    "--qa-action-y": `${target.y}px`,
    "--qa-action-from-x": `${start.x}px`,
    "--qa-action-from-y": `${start.y}px`,
    "--qa-open-delay": `${index * ACTION_STAGGER_MS}ms`,
    "--qa-close-delay": `${(count - 1 - index) * ACTION_STAGGER_MS}ms`,
    "--qa-slice-turn": `${(index * 360) / Math.max(1, count)}deg`,
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
