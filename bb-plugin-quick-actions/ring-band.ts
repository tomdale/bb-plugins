/**
 * The hold ring's outer band: a second ring of options that grows out of one
 * action's slice (Snooze and its wake presets). It is one object, an annular
 * sector on the disc rim, whose outer radius and angular span spring outward
 * from the parent wedge. Its options ride inside it on a common radius, the
 * default directly outward from the parent, earlier options counter-clockwise
 * and later ones clockwise. The band lives inside the ring body, so the
 * ring's own open, shake and close transforms carry it.
 *
 * Labels never show outside the band's surface: each fades in once the
 * unfolding band covers it, and on retract the labels go before the band
 * folds back.
 */
import {
  COLOR,
  GROW,
  Spring,
  TILE_ALPHA,
  TILE_ALPHA_FLASH,
  TILE_GAP_PX,
  TILE_SLIDE_W,
  Tween,
  clamp,
  easeIn2,
  lerp,
  linear,
  pt,
  unwrap,
  wedgePath,
} from "./ring-pie";

/** The band's inner edge sits on the disc rim; its outline covers the join,
 * so no page shows between the two. */
const BAND_GAP_PX = 0;
/** A label starts to fade in once the band's surface covers it with this
 * much to spare: px past its outer edge, degrees past its side. */
const COVER_FADE_PX = 4;
const COVER_FADE_DEG = 1;
const BAND_CORNER_PX = 10;
/** The selection tile's inset from the band's edges. */
const TILE_INSET_PX = 4;
const ITEM_SIDE_PX = 10;
const ITEM_PAD_PX = 13;

const TIME_IDLE = [139, 142, 150];
const TIME_LIT = [200, 202, 208];
const rgba = (c: readonly number[], a = 1) =>
  `rgba(${c.map((x) => Math.round(x)).join(",")},${+a.toFixed(3)})`;
const mix = (a: readonly number[], b: readonly number[], u: number) =>
  a.map((x, i) => lerp(x, b[i]!, clamp(u)));

export type RingBandElements = {
  svg: SVGSVGElement;
  plate: SVGPathElement;
  outline: SVGPathElement;
  /** A 1px lighter rim inside the outline, like the disc's inset highlight. */
  rim: SVGPathElement;
  tileGroup: SVGGElement;
  tile: SVGPathElement;
  items: HTMLElement[];
  /** The thread name plate, which the band covers at the top of the ring. */
  title: HTMLElement | null;
  /** The parent item's outward chevron, which shows while the band is folded. */
  more: HTMLElement | null;
};

type BandItem = { r: Spring; o: Tween; c: Tween; g: Spring; rad: number; tanDeg: number; shown: boolean };

export class RingBand {
  sel = -1;
  extended = false;
  readonly R0: number;
  readonly R1: number;
  readonly step: number;
  private t = 0;
  private last: number | null = null;
  private frame: number | null = null;
  private readonly springs: (Spring | Tween)[] = [];
  private queue: { t: number; fn: () => void }[] = [];
  private readonly presence: Spring;
  private readonly unfold: Spring;
  private readonly fade: Tween;
  private readonly flash: Tween;
  private readonly bump: Spring;
  private readonly tileAngle: Spring;
  private readonly tileFade: Tween;
  private readonly titleFade: Tween;
  private readonly moreFade: Tween;
  private tileShown = false;
  private readonly items: BandItem[];
  private rm: number;
  private running = false;
  private destroyed = false;

  constructor(
    private readonly el: RingBandElements,
    /** Clockwise degrees of the parent action's slot. */
    private readonly center: number,
    /** Half the parent wedge, where the band starts. */
    private readonly startHalf: number,
    /** Index of the default option, which sits directly outward. */
    private readonly anchor: number,
    discRadius: number,
    private readonly reduced: boolean,
  ) {
    // Fit like the disc: every grown label box clears the band's edges by a
    // pad at its own angle, and neighbours clear each other by a side gap.
    // A label beside the ring lies along the radius, so the band is as
    // thick as the widest label there.
    const boxes = el.items.map((item) => ({ w: item.offsetWidth * GROW, h: item.offsetHeight * GROW }));
    const extent = (b: { w: number; h: number }, a: number) => {
      const t = (a * Math.PI) / 180;
      const sx = Math.abs(Math.sin(t));
      const cy = Math.abs(Math.cos(t));
      return { rad: (b.w / 2) * sx + (b.h / 2) * cy, tan: (b.w / 2) * cy + (b.h / 2) * sx };
    };
    this.R0 = discRadius + BAND_GAP_PX;
    let step = 30;
    let rm = this.R0 + 40;
    let radMax = 0;
    for (let pass = 0; pass < 6; pass += 1) {
      const e = boxes.map((b, i) => extent(b, this.center + (i - anchor) * step));
      radMax = Math.max(...e.map((x) => x.rad));
      rm = this.R0 + ITEM_PAD_PX + radMax;
      const r = rm - radMax / 2;
      let need = 0;
      for (let i = 0; i + 1 < e.length; i += 1) {
        need = Math.max(need, (e[i]!.tan + e[i + 1]!.tan + 2 * ITEM_SIDE_PX) / r);
      }
      step = (need * 180) / Math.PI || 30;
    }
    this.step = step;
    this.rm = rm;
    const fitted = boxes.map((b, i) => extent(b, this.center + (i - anchor) * step));
    this.R1 = Math.ceil(rm + radMax + ITEM_PAD_PX);
    const now = () => this.t;
    const S = (x: number, k: number, z: number) => {
      const s = new Spring(x, k, z, reduced);
      this.springs.push(s);
      return s;
    };
    const T = (x: number) => {
      const tw = new Tween(x, now);
      this.springs.push(tw);
      return tw;
    };
    this.presence = S(0, 900, 0.8);
    this.unfold = S(0, 700, 0.85);
    this.fade = T(0);
    this.flash = T(0);
    this.bump = S(1, 1200, 0.55);
    this.tileAngle = S(0, 1, 1);
    this.tileFade = T(0);
    this.titleFade = T(1);
    this.moreFade = T(1);
    this.items = el.items.map((_, i) => ({
      r: S(this.rm - 10, 900, 0.7),
      o: T(0),
      c: T(0),
      g: S(1, 2500, 1),
      rad: fitted[i]!.rad,
      tanDeg: (fitted[i]!.tan / (this.rm - radMax / 2)) * (180 / Math.PI),
      shown: false,
    }));
    el.svg.dataset.extended = "false";
    this.render();
    this.start();
  }

  /** Direction of the default option, which release takes from the parent slot. */
  get defaultAngle() {
    return this.angleOf(this.anchor);
  }

  angleOf(i: number) {
    return this.center + (i - this.anchor) * this.step;
  }

  private get span() {
    return [this.angleOf(0) - this.step / 2, this.angleOf(this.items.length - 1) + this.step / 2] as const;
  }

  /** True when this direction falls on the band, with a few degrees of slack. */
  contains(ang: number) {
    const [a0, a1] = this.span;
    const a = unwrap(ang, (a0 + a1) / 2);
    return a >= a0 - 4 && a <= a1 + 4;
  }

  extend() {
    if (this.extended) return;
    this.extended = true;
    // Only an open band takes presses, so a folded one never blocks the page.
    this.el.svg.dataset.extended = "true";
    this.queue = [];
    this.presence.set(1);
    this.unfold.set(1);
    this.fade.go(1, this.reduced ? 60 : 40, linear);
    // The band covers the top of the ring, where the thread name sits, and
    // takes over from the chevron that pointed to it.
    this.titleFade.go(0, 30, linear);
    this.moreFade.go(0, 40, linear);
    // Each option fades in once the unfolding band covers it (see render), so
    // they appear outward from the default.
    for (const item of this.items) item.r.set(this.rm);
    this.start();
  }

  retract() {
    if (!this.extended) return;
    this.extended = false;
    this.el.svg.dataset.extended = "false";
    this.queue = [];
    this.aim(null);
    // Labels leave first while the band holds still, then it folds back into
    // the parent wedge and fades, so no label is cut off by the moving edge.
    for (const item of this.items) {
      item.shown = false;
      item.o.go(0, 40, linear);
    }
    this.at(40, () => {
      if (this.extended) return;
      for (const item of this.items) item.r.jump(this.rm - 10);
      this.presence.chase(0, 28);
      this.unfold.chase(0, 28);
    });
    this.fade.go(0, 60, easeIn2, 80);
    this.titleFade.go(1, 80, linear);
    this.moreFade.go(1, 80, linear, 100);
    this.start();
  }

  /** Selects the option in this direction, or clears with null. */
  aim(ang: number | null) {
    let sel = -1;
    if (ang !== null && this.extended) {
      const i = Math.round((unwrap(ang, this.center) - this.center) / this.step) + this.anchor;
      sel = clamp(i, 0, this.items.length - 1);
    }
    if (sel === this.sel) return;
    this.sel = sel;
    this.items.forEach((item, i) => {
      const on = i === sel;
      item.c.jump(on ? 1 : 0);
      item.g.set(on && !this.reduced ? GROW : 1);
      this.el.items[i]!.dataset.selected = on ? "true" : "false";
    });
    if (sel < 0) {
      this.tileShown = false;
    } else if (this.tileShown) {
      this.tileAngle.chase(unwrap(this.angleOf(sel), this.tileAngle.x), TILE_SLIDE_W, 18);
    } else {
      this.tileShown = true;
      this.tileAngle.jump(this.angleOf(sel));
      this.tileFade.jump(this.reduced ? 1 : 0.4).go(1, 50, linear);
    }
    this.render();
    this.start();
  }

  /** The run confirm on the chosen option; the ring's close carries the rest. */
  confirm() {
    this.flash.jump(1).go(0, 160);
    this.bump.kick(1);
    // The disc's run timing: other labels go in 30ms, the chosen one 20ms
    // after, and the plate is gone before the ring's collapse can fling it.
    this.items.forEach((item, i) => {
      if (i === this.sel) item.o.go(0, 20, linear, 30);
      else item.o.go(0, 30, linear);
    });
    this.fade.go(0, 40, linear, 30);
    this.start();
  }

  destroy() {
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private at(ms: number, fn: () => void) {
    if (ms <= 0) fn();
    else this.queue.push({ t: this.t + ms, fn });
  }

  /** The band runs on its own clock for as long as the ring is open. */
  private start() {
    if (this.running || this.destroyed) return;
    this.running = true;
    this.frame = requestAnimationFrame(this.loop);
  }

  private loop = (now: number) => {
    if (this.destroyed) return;
    let rem = this.last === null ? 16 : Math.min(50, Math.max(0, now - this.last));
    this.last = now;
    while (rem > 1e-9) {
      const d = Math.min(1, rem);
      this.t += d;
      if (this.queue.length) {
        const due = this.queue.filter((q) => q.t <= this.t);
        this.queue = this.queue.filter((q) => q.t > this.t);
        for (const q of due) q.fn();
      }
      for (const s of this.springs) s.tick(d / 1000);
      rem -= d;
    }
    this.render();
    this.frame = requestAnimationFrame(this.loop);
  };

  private render() {
    const el = this.el;
    const R = this.reduced;
    const p = R ? (this.extended ? 1 : this.fade.x) : clamp(this.presence.x, 0, 1.03);
    const u = R ? 1 : clamp(this.unfold.x, 0, 1.03);
    const [a0, a1] = this.span;
    const mid = (a0 + a1) / 2;
    const half = lerp(this.startHalf, (a1 - a0) / 2, u);
    const centre = lerp(this.center, mid, u);
    const outer = lerp(this.R0 + 6, this.R1, p);
    const c = clamp((outer - this.R0) / 2 - 0.5, 0, BAND_CORNER_PX);
    const visible = this.fade.x > 0.002 && outer - this.R0 > 1.5;
    el.svg.style.opacity = visible ? this.fade.x.toFixed(3) : "0";
    if (el.title) el.title.style.opacity = this.titleFade.x.toFixed(3);
    if (el.more) el.more.style.opacity = this.moreFade.x.toFixed(3);
    if (visible) {
      const d = wedgePath(outer - c, this.R0 + c, 2 * c, centre - half, centre + half);
      // Three layers of one rounded shape: black outline, light rim, fill.
      el.outline.setAttribute("d", d);
      el.outline.style.strokeWidth = (2 * c + 2).toFixed(2);
      el.rim.setAttribute("d", d);
      el.rim.style.strokeWidth = (2 * c).toFixed(2);
      el.plate.setAttribute("d", d);
      el.plate.style.strokeWidth = Math.max(0, 2 * c - 2).toFixed(2);
    }

    // How much of each label the band's surface covers right now: labels and
    // the tile never show outside it, entering or leaving.
    const cover = this.items.map((item, i) => {
      if (R || !visible) return R ? 1 : 0;
      const a = this.angleOf(i);
      const radial = (outer - (this.rm + item.rad)) / COVER_FADE_PX;
      const side = Math.min(a - item.tanDeg - (centre - half), centre + half - (a + item.tanDeg));
      return clamp(Math.min(radial, side / COVER_FADE_DEG));
    });
    this.items.forEach((item, i) => {
      if (this.extended && !item.shown && cover[i]! >= 1) {
        item.shown = true;
        item.o.go(1, 60, linear);
      }
    });

    // The tile grows with the band from its first frame, clipped to the
    // band's current edge, so a fast flick shows its option at once.
    const tin = this.R0 + TILE_INSET_PX;
    const tout = Math.min(this.R1, outer) - TILE_INSET_PX;
    const tileSide = (() => {
      if (R || this.sel < 0) return 1;
      const a = this.angleOf(this.sel);
      const h = this.step / 2;
      return clamp(Math.min(a - h - (centre - half), centre + half - (a + h)) / COVER_FADE_DEG + 1);
    })();
    const showTile = this.tileShown && this.sel >= 0 && visible && tout - tin > 4 && tileSide > 0;
    el.tileGroup.style.opacity = showTile ? (this.tileFade.x * tileSide).toFixed(3) : "0";
    if (showTile) {
      const tc = Math.min(8, (tout - tin) / 2 - 0.5);
      const h = this.step / 2;
      el.tile.setAttribute(
        "d",
        wedgePath(tout - tc, tin + tc, TILE_GAP_PX + 2 * tc, this.tileAngle.x - h, this.tileAngle.x + h),
      );
      el.tile.style.strokeWidth = (2 * tc).toFixed(2);
      el.tile.style.opacity = lerp(TILE_ALPHA, TILE_ALPHA_FLASH, clamp(this.flash.x)).toFixed(3);
    }

    this.items.forEach((item, i) => {
      const node = el.items[i]!;
      const ci = clamp(item.c.x);
      const bump = i === this.sel ? this.bump.x : 1;
      const [x, y] = pt(item.r.x * bump, this.angleOf(i));
      const grow = R ? "" : ` scale(${item.g.x.toFixed(4)})`;
      node.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) translate(-50%, -50%)${grow}`;
      node.style.opacity = (item.o.x * (cover[i]! > 0 ? 1 : 0)).toFixed(3);
      node.style.color = rgba(mix(COLOR.text, COLOR.white, ci));
      node.style.fontWeight = ci > 0.5 ? "600" : "";
      const timeNode = node.querySelector<HTMLElement>(".qa-ring-time");
      if (timeNode) timeNode.style.color = rgba(mix(TIME_IDLE, TIME_LIT, ci));
    });

  }
}
