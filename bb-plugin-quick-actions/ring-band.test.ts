// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RingBand } from "./ring-band";

let frames: FrameRequestCallback[] = [];
let now = 0;

beforeEach(() => {
  frames = [];
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function advance(milliseconds: number) {
  for (let t = 0; t < milliseconds; t += 16) {
    now += 16;
    const due = frames;
    frames = [];
    for (const callback of due) callback(now);
  }
}

const svg = (tag: string) => document.createElementNS("http://www.w3.org/2000/svg", tag);

/** A label whose box is `width` × 30 px, as layout would measure it. */
function label(width: number) {
  const node = document.createElement("div");
  Object.defineProperty(node, "offsetWidth", { value: width });
  Object.defineProperty(node, "offsetHeight", { value: 30 });
  return node;
}

function band(widths: readonly number[], anchor: number) {
  const items = widths.map(label);
  const ring = new RingBand(
    {
      svg: svg("svg") as SVGSVGElement,
      outline: svg("path") as SVGPathElement,
      rim: svg("path") as SVGPathElement,
      plate: svg("path") as SVGPathElement,
      tileGroup: svg("g") as SVGGElement,
      tile: svg("path") as SVGPathElement,
      items,
      title: null,
      more: null,
    },
    72,
    36,
    anchor,
    126,
    false,
  );
  return { ring, items };
}

describe("RingBand", () => {
  it("shows every label once open, including a wide one beside a narrow one at either end", () => {
    // "20 minutes" beside "1 hour" opens the band; "Next week" beside a short label ends it.
    const { ring, items } = band([96, 52, 64, 120, 40], 2);
    ring.extend();
    advance(600);
    expect(items.map((item) => Number(item.style.opacity))).toEqual([1, 1, 1, 1, 1]);
    ring.destroy();
  });

  it("hides every label before the band folds back", () => {
    const { ring, items } = band([96, 52, 64, 120, 40], 2);
    ring.extend();
    advance(600);
    ring.retract();
    advance(48);
    expect(items.map((item) => Number(item.style.opacity))).toEqual([0, 0, 0, 0, 0]);
    ring.destroy();
  });
});
