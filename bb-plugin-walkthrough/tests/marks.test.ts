// The page marks in the top bar are the pane's only position control, and they
// are 6px drawn on glass. This measures them from app.css itself, so the numbers
// cannot drift from what ships: a mark the reader has not reached yet has to stay
// visible against the glass (3:1, the ratio for a small indicator that carries
// state), a mark behind them has to read clearly stronger, and the current page
// has to be the strongest of the three. It also pins the accent's single job: the
// primary action is drawn in ink, never in the yellow that marks the page.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Rgb = [number, number, number];
const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");

/** The declarations of the first rule whose selector line is exactly `selector`, as name → value. */
function declarations(source: string, selector: string): Map<string, string> {
  const start = source.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule ${selector}`);
  const open = source.indexOf("{", start);
  const body = source.slice(open + 1, source.indexOf("\n}", open));
  const found = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/gu)) found.set(match[1]!, match[2]!.trim());
  return found;
}

const base = declarations(css, ".wt,\n.wt-portal");
const themes = [
  { name: "light", get: (name: string) => base.get(name) },
  // The dark block overrides what it declares and inherits the rest, so a token it leaves out keeps the base value resolved against dark's own inks.
  { name: "dark", get: (name: string) => declarations(css, ".dark .wt,\n.dark .wt-portal").get(name) ?? base.get(name) },
];

/** A colour a rule paints literally; a reference to another token is resolved against `get`. */
function colour(get: (name: string) => string | undefined, value: string, seen = 0): { rgb: Rgb; alpha: number } {
  const reference = /^var\((--[\w-]+)\)$/u.exec(value.trim());
  if (reference) {
    if (seen > 8) throw new Error(`token loop at ${value}`);
    const next = get(reference[1]!);
    if (next === undefined) throw new Error(`no token ${reference[1]}`);
    return colour(get, next, seen + 1);
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value);
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((character) => character + character).join("") : hex[1]!;
    return { rgb: [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)) as Rgb, alpha: 1 };
  }
  const rgba = /^rgba?\(([^)]+)\)$/u.exec(value);
  if (!rgba) throw new Error(`cannot read ${value}`);
  const [r, g, b, a] = rgba[1]!.split(",").map((part) => Number(part.trim()));
  return { rgb: [r!, g!, b!], alpha: a ?? 1 };
}

const over = (top: Rgb, alpha: number, under: Rgb): Rgb => top.map((channel, at) => channel * alpha + under[at]! * (1 - alpha)) as Rgb;
function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** What the top bar is drawn on: its glass over the pane's desk. */
function ground(get: (name: string) => string | undefined): Rgb {
  const desk = colour(get, get("--wt-desk")!);
  const glass = colour(get, get("--wt-glass")!);
  return over(glass.rgb, glass.alpha, desk.rgb);
}

/** The ratio a token's paint reaches on that ground. */
function ratio(get: (name: string) => string | undefined, token: string): number {
  const paint = colour(get, get(token)!);
  const under = ground(get);
  return contrast(over(paint.rgb, paint.alpha, under), under);
}

describe("page marks", () => {
  it("keeps a mark the reader has not reached visible, and a past one clearly stronger", () => {
    for (const { name, get } of themes) {
      const ahead = ratio(get, "--wt-mark");
      const past = ratio(get, "--wt-mark-past");
      const current = ratio(get, "--wt-ink");
      expect(ahead, `${name}: a mark ahead of the reader`).toBeGreaterThanOrEqual(3);
      expect(past, `${name}: a mark behind the reader`).toBeGreaterThanOrEqual(ahead * 2);
      expect(current, `${name}: the current page`).toBeGreaterThanOrEqual(past);
    }
  });

  it("draws the marks and their states from those tokens, not from the hairlines", () => {
    const dot = /\.wt-dots i \{([^}]*)\}/u.exec(css)![1]!;
    const past = /\.wt-dots i\.wt-past \{([^}]*)\}/u.exec(css)![1]!;
    const current = /\.wt-dots i\.wt-on \{([^}]*)\}/u.exec(css)![1]!;
    expect(dot).toContain("var(--wt-mark)");
    expect(past).toContain("var(--wt-mark-past)");
    expect(current).toContain("var(--wt-ink)");
    expect(dot).not.toContain("--wt-hair");
  });
});

describe("the accent's one job", () => {
  it("keeps the primary action in ink, so yellow only ever marks the page", () => {
    for (const { name, get } of themes) {
      for (const token of ["--wt-btn", "--wt-btnt"]) {
        expect(get(token), `${name}: ${token}`).not.toMatch(/ffcc00|ffb400|--wt-y\b/iu);
      }
      const fill = colour(get, get("--wt-btn")!);
      const text = colour(get, get("--wt-btnt")!);
      expect(contrast(fill.rgb, text.rgb), `${name}: primary action text`).toBeGreaterThanOrEqual(7);
    }
  });
});
