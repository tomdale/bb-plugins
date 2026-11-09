export const MENU_DURATION_MS = 240;
export const ACTION_SPRING_MS = 160;
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

export function sanitizeCorner(value: unknown): Corner {
  return CORNERS.find((corner) => corner === value) ?? "bottom-left";
}

export function sanitizeMotion(value: unknown): QuickActionMotion {
  return MOTIONS.find((motion) => motion === value) ?? "ring";
}

/** A fixed-step damped spring sampled by the interactive animation clock. */
export function spring(
  progress: number,
  stiffness = 290,
  damping = 23,
  durationSeconds = 0.52,
): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const step = 1 / 120;
  const end = progress * durationSeconds;
  let position = 0;
  let velocity = 0;
  for (let elapsed = 0; elapsed < end; elapsed += step) {
    const acceleration = stiffness * (1 - position) - damping * velocity;
    velocity += acceleration * step;
    position += velocity * step;
  }
  return position;
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

export function actionFrame({
  motion,
  index,
  count,
  corner,
  time,
  reducedMotion,
}: {
  motion: QuickActionMotion;
  index: number;
  count: number;
  corner: Corner;
  time: number;
  reducedMotion: boolean;
}): { transform: string; opacity: number } {
  const target = actionTarget(index, count, corner);
  if (reducedMotion) {
    return {
      transform: `translate(${target.x}px, ${target.y}px)`,
      opacity: Math.min(1, Math.max(0, time) / 120),
    };
  }

  const delay = motion === "ring" ? 0 : index * ACTION_STAGGER_MS;
  const local = Math.max(0, Math.min(1, (time - delay) / ACTION_SPRING_MS));
  const progress = spring(local, 290, 23, 0.16);
  let x = target.x;
  let y = target.y;
  let scale = 1;
  let opacity = Math.min(1, local * 4);

  if (motion === "arc") {
    x *= progress;
    y *= progress;
    scale = 0.55 + 0.45 * progress;
  } else {
    const ringProgress = spring(time / MENU_DURATION_MS, 250, 25, 0.16);
    x *= ringProgress;
    y *= ringProgress;
    scale = 0.7 + 0.3 * ringProgress;
    opacity = Math.min(1, Math.max(0, time / MENU_DURATION_MS) * 5);
  }

  return {
    transform: `translate(${x}px, ${y}px) scale(${scale})`,
    opacity,
  };
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

export function triggerRotation(time: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  return 45 * Math.min(1, Math.max(0, time / MENU_DURATION_MS) * 4);
}
