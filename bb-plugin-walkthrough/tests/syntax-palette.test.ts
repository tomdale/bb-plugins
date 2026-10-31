// The code palette's contrast, measured from app.css itself so the numbers
// cannot drift from what ships. Each ink is checked on the page, on the added
// and removed line tints, on the deeper tint of a changed word, and under the
// yellow wash of a hovered row (alone and over each of those), with removed
// lines at their reduced opacity: the worst of those grounds must reach 4.5:1,
// and, under `prefers-contrast: more`, 7:1 on lines and 4.5:1 on a changed word or a hovered tinted row.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLES } from "../src/syntax/roles.ts";

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

const light = declarations(css, ".wt,\n.wt-portal");
const dark = declarations(css, ".dark .wt,\n.dark .wt-portal");
const highContrast = css.slice(css.indexOf("@media (prefers-contrast: more)"));

function parse(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value);
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
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

/** The grounds a line of code can sit on, keyed so removed ones can dim their ink. */
function grounds(vars: Map<string, string>) {
  const get = (name: string) => parse(vars.get(name)!);
  const page = get("--wt-page").rgb;
  const tint = (name: string, under: Rgb) => over(get(name).rgb, get(name).alpha, under);
  const hot = (under: Rgb) => over(get("--wt-yhi").rgb, vars.has("--wt-yhi-row") && vars.get("--wt-yhi-row") !== "var(--wt-yhi)" ? parse(vars.get("--wt-yhi-row")!).alpha : get("--wt-yhi").alpha, under);
  const add = tint("--wt-add", page);
  const del = tint("--wt-del", page);
  const lines = { page, add, del, hot: hot(page), hotAdd: hot(add), hotDel: hot(del) };
  const words = { addWord: tint("--wt-add-word", add), delWord: tint("--wt-del-word", del), hotAddWord: tint("--wt-add-word", hot(add)), hotDelWord: tint("--wt-del-word", hot(del)) };
  return { lines, words };
}

const REMOVED_OPACITY = Number(/\.wt-del \.wt-text \{ opacity: ([\d.]+); \}/u.exec(css)![1]);

/** An ink as painted: drawn `strength`% of the way from the page's ink to itself (color-mix in sRGB). */
const painted = (ink: Rgb, strength: number, pageInk: Rgb): Rgb => over(ink, strength / 100, pageInk);
const percent = (value: string) => Number.parseFloat(value);

/** The lowest margin over `need` across every ground: the ratio on a line ground must reach `need.line`, on a changed word's `need.word`. */
function worst(mode: "light" | "dark", role: string, strength: number, wordStrength: number, need: { line: number; word: number }) {
  const vars = mode === "light" ? light : dark;
  const ink = parse((mode === "light" ? light : { get: (n: string) => dark.get(n) ?? light.get(n) }).get(`--wt-tk-${role}`)!).rgb;
  const pageInk = parse(vars.get("--wt-ink")!).rgb;
  const { lines, words } = grounds(new Map([...light, ...vars]));
  let min = Infinity;
  let where = "";
  for (const [tier, set, level] of [["line", lines, strength], ["word", words, wordStrength]] as const) {
    for (const [name, ground] of Object.entries(set)) {
      const drawn = painted(ink, level, pageInk);
      const effective = /[dD]el/u.test(name) ? over(drawn, REMOVED_OPACITY, ground) : drawn;
      // A hovered row over a tint, and a changed word, are the deepest grounds: `need.word` applies to them.
      const ratio = contrast(effective, ground) / (tier === "word" || /^hot(Add|Del)$/u.test(name) ? need.word : need.line);
      if (ratio < min) [min, where] = [ratio, `${tier}:${name}`];
    }
  }
  return { min, where };
}

const INK_ROLES = ROLES.filter((role) => role !== "heading");

describe("code palette", () => {
  it("defines every role except the heading, which borrows the type ink", () => {
    for (const role of INK_ROLES) {
      expect(light.has(`--wt-tk-${role}`), `light ${role}`).toBe(true);
      expect(dark.has(`--wt-tk-${role}`), `dark ${role}`).toBe(true);
    }
    expect(css).toMatch(/\.wt-tk-heading \{ --tk: var\(--wt-tk-type\);/u);
  });

  for (const mode of ["light", "dark"] as const) {
    it(`reads at 4.5:1 on every row tint in ${mode} mode`, () => {
      const vars = mode === "light" ? light : dark;
      const strength = percent(light.get("--wt-tk-strength")!);
      const word = percent(vars.get("--wt-tk-word") ?? light.get("--wt-tk-word")!);
      for (const role of INK_ROLES) {
        const { min, where } = worst(mode, role, strength, word, { line: 4.5, word: 4.5 });
        expect(min, `${mode} ${role} on ${where}`).toBeGreaterThanOrEqual(1);
      }
    });

    it(`reads at 7:1 on lines (4.5:1 on the deepest grounds) under increased contrast in ${mode} mode`, () => {
      const block = highContrast;
      const strength = percent(/\.wt, \.wt-portal \{ --wt-tk-strength: ([\d.]+)%;/u.exec(block)![1]!);
      const word = percent((mode === "light" ? /\.wt, \.wt-portal \{ --wt-tk-strength: [\d.]+%; --wt-tk-word: ([\d.]+)%;/u : /\.dark \.wt, \.dark \.wt-portal \{ --wt-tk-word: ([\d.]+)%;/u).exec(block)![1]!);
      for (const role of INK_ROLES) {
        // The deepest grounds (a changed word, a hovered added or removed row) are held to 4.5:1: the page's own ink only reaches about 6:1 on the worst of them.
        const { min, where } = worst(mode, role, strength, word, { line: 7, word: 4.5 });
        expect(min, `${mode} ${role} on ${where}`).toBeGreaterThanOrEqual(1);
      }
    });
  }

  it("never uses the yellow accent for a token", () => {
    const accent = parse(light.get("--wt-y")!).rgb;
    const hueOf = ([r, g, b]: Rgb) => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min) return null;
      const d = max - min;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const accentHue = hueOf(accent)!;
    for (const vars of [light, dark]) {
      for (const role of INK_ROLES) {
        const hue = hueOf(parse(vars.get(`--wt-tk-${role}`)!).rgb);
        if (hue === null) continue;
        const away = Math.min(Math.abs(hue - accentHue), 360 - Math.abs(hue - accentHue));
        // Near-neutral warm inks (comment, punctuation) are not yellow; the rest keep clear of the accent's hue.
        const [r, g, b] = parse(vars.get(`--wt-tk-${role}`)!).rgb;
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        if (chroma > 40) expect(away, `${role} hue ${hue}`).toBeGreaterThan(20);
      }
    }
  });
});
