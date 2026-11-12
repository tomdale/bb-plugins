import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("./app.css", import.meta.url)),
  "utf8",
);

/** Declarations of one rule, keyed by selector, in source order. */
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`missing rule ${selector}`);
  const end = css.indexOf("}", start);
  return css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("window drag regions", () => {
  // Chromium builds the native draggable region by walking every box that
  // declares app-region, ignoring pointer-events, so a window-sized no-drag
  // box removes the title bar from it and the window cannot be dragged.
  it("leaves the full-window hold overlay out of the draggable region", () => {
    const hold = rule(".qa-hold");
    expect(hold).not.toMatch(/app-region/);
    expect(hold).toMatch(/inset: 0;/);
  });

  it("keeps the clickable hold disc out of native dragging", () => {
    const disc = rule(".qa-ring-base");
    expect(disc).toMatch(/-webkit-app-region: no-drag;/);
    expect(disc).toMatch(/\bapp-region: no-drag;/);
  });
});
