import { describe, expect, it } from "vitest";
import { LAG_MS, LUMP_MIN, TextPacer, prefixOf } from "../src/ui/pace.ts";

/** Runs a pacer over `steps` of [time, received length], sampling every `frame` ms until `end`. */
function run(steps: Array<[number, number]>, end: number, frame = 16, headEnd = Number.POSITIVE_INFINITY) {
  const pacer = new TextPacer();
  const trace: Array<[number, number, number]> = [];
  let next = 0;
  for (let t = 0; t <= end; t += frame) {
    while (next < steps.length && steps[next]![0] <= t) pacer.receive(steps[next]![1], steps[next]![0], false, headEnd), next += 1;
    trace.push([t, pacer.advance(t), steps.slice(0, next).at(-1)?.[1] ?? 0]);
  }
  return { pacer, trace };
}

describe("TextPacer", () => {
  it("shows an ordinary trickle at once", () => {
    const pacer = new TextPacer();
    for (const [t, length] of [[0, 25], [55, 52], [110, 80], [165, 119]] as const) {
      pacer.receive(length, t, false);
      expect(pacer.shown).toBe(length);
      expect(pacer.busy).toBe(false);
    }
  });

  it("reveals a lump at a steady speed and has all of it by the deadline", () => {
    const { trace } = run([[0, 600]], 2000);
    const shown = trace.map(([, s]) => s);
    expect(shown[0]).toBe(0);
    expect(trace.find(([, s]) => s === 600)![0]).toBeLessThanOrEqual(LAG_MS + 16);
    // Monotonic, and no step is more than twice the average: a wipe, not a jump.
    const steps = shown.slice(1).map((value, index) => value - shown[index]!);
    expect(steps.every((step) => step >= 0)).toBe(true);
    const average = 600 / (LAG_MS / 16);
    expect(Math.max(...steps)).toBeLessThanOrEqual(average * 2);
  });

  it("never shows less than what arrived LAG_MS ago, and never more than has arrived", () => {
    // A lump, a trickle behind it, a second lump, then quiet.
    const steps: Array<[number, number]> = [[0, 700], [60, 730], [120, 760], [400, 800], [900, 1500], [950, 1530], [1000, 1560]];
    const { trace } = run(steps, 4000);
    const received = (t: number) => steps.filter(([at]) => at <= t).at(-1)?.[1] ?? 0;
    for (const [t, shown, got] of trace) {
      expect(shown).toBeLessThanOrEqual(got);
      expect(shown).toBeGreaterThanOrEqual(received(t - LAG_MS) - 1);
    }
    expect(trace.at(-1)![1]).toBe(1560);
  });

  it("holds text that arrives behind a lump until the lump is shown", () => {
    const pacer = new TextPacer();
    pacer.receive(600, 0, false);
    pacer.advance(100);
    pacer.receive(640, 100, false);
    // 40 small characters are queued behind the lump, not shown ahead of it.
    expect(pacer.shown).toBeLessThan(600);
    expect(pacer.advance(LAG_MS)).toBe(640);
  });

  it("spends the time on the text on screen and shows what is hidden behind it as soon as it is reached", () => {
    // 2,000 characters arrive at once; the first 700 are the introduction, the rest is part 1 behind it.
    const { trace } = run([[0, 2000]], 2000, 16, 700);
    const reveal = trace.find(([, shown]) => shown >= 700)!;
    expect(reveal[0]).toBeGreaterThanOrEqual(LAG_MS - 32);
    expect(reveal[0]).toBeLessThanOrEqual(LAG_MS + 16);
    // At 700 characters in LAG_MS the introduction is written at about 580 characters a second, not 1,700.
    const before = trace.filter(([, shown]) => shown < 700).map(([, shown]) => shown);
    const steps = before.slice(1).map((value, index) => value - before[index]!);
    expect(Math.max(...steps)).toBeLessThanOrEqual((700 / (LAG_MS / 16)) * 2);
    expect(trace.find(([, shown]) => shown === 2000)![0]).toBeLessThanOrEqual(LAG_MS + 16);
  });

  it("shows everything at once when told to, and starts over on shorter text", () => {
    const pacer = new TextPacer();
    pacer.receive(2000, 0, true);
    expect(pacer.shown).toBe(2000);
    expect(pacer.busy).toBe(false);
    pacer.receive(500, 10, false);
    expect(pacer.shown).toBe(500);
    pacer.receive(500 + LUMP_MIN, 20, false);
    expect(pacer.busy).toBe(true);
    pacer.receive(900, 30, true);
    expect(pacer.shown).toBe(900);
  });

  it("holds invariants for random arrival schedules", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let round = 0; round < 200; round += 1) {
      const steps: Array<[number, number]> = [];
      let t = 0;
      let length = 0;
      for (let i = 0; i < 20; i += 1) {
        t += Math.floor(random() * 300);
        length += random() < 0.2 ? LUMP_MIN + Math.floor(random() * 2000) : 1 + Math.floor(random() * 60);
        steps.push([t, length]);
      }
      const { trace } = run(steps, t + LAG_MS + 100, 8 + Math.floor(random() * 40), random() < 0.5 ? Number.POSITIVE_INFINITY : Math.floor(random() * length));
      let last = 0;
      for (const [time, shown, got] of trace) {
        expect(shown).toBeGreaterThanOrEqual(last);
        expect(shown).toBeLessThanOrEqual(got);
        const due = steps.filter(([at]) => at <= time - LAG_MS - 50).at(-1)?.[1] ?? 0;
        expect(shown).toBeGreaterThanOrEqual(due);
        last = shown;
      }
      expect(trace.at(-1)![1]).toBe(length);
    }
  });
});

describe("prefixOf", () => {
  it("does not split a surrogate pair", () => {
    expect(prefixOf("ab😀cd", 3)).toBe("ab");
    expect(prefixOf("ab😀cd", 4)).toBe("ab😀");
    expect(prefixOf("abc", 9)).toBe("abc");
  });
});
