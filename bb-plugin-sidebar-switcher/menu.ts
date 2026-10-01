// Keyboard model for the switcher menu, following the WAI-ARIA menu pattern:
// arrows move between enabled items and wrap, Home/End jump to the ends.

/**
 * The index to focus after `key`, or null when the key is not a menu
 * navigation key. `current` is -1 when focus is not on an item.
 */
export function menuFocusTarget(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return current === -1 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current === -1 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
