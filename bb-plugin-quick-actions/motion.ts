import type { CSSProperties } from "react";

export const ACTION_STAGGER_MS = 12;
export const MENU_RADIUS_PX = 116;

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
 * o'clock, so the fan reads the same wherever it opens.
 */
export function cursorActionTarget(
  index: number,
  count: number,
): { x: number; y: number } {
  const step = (Math.PI * 2) / Math.max(1, count);
  const angle = -Math.PI / 2 + step * index;
  return {
    x: Math.cos(angle) * MENU_RADIUS_PX,
    y: Math.sin(angle) * MENU_RADIUS_PX,
  };
}

/**
 * Keeps the whole fan inside the window: near an edge the fan centre moves in
 * far enough that no action is clipped offscreen.
 */
export function clampMenuOrigin(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const inset = MENU_RADIUS_PX + 26;
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
