/**
 * The hold-Option ring: an opaque disc of actions around a static hub, with a
 * quiet tile that slides to the selected wedge while the selected icon and
 * label grow slightly in place.
 *
 * React renders the ring's DOM once per opening; {@link RingPie} then owns
 * every animated property and writes it inline each frame. Motion runs on the
 * ring's own clock in fixed 1ms substeps, so springs behave the same at any
 * frame rate. State changes (selection, close) apply inside the pointer or key
 * event and render in that tick; motion only follows them.
 */

export const RING_DEAD_ZONE_PX = 36;
export const RING_MAX_ACTIONS = 10;

const HUB_RADIUS_PX = 32;
/** Labels keep this far from the hub's edge. */
const HUB_CLEARANCE_PX = 10;
/** The tile's inner radius, outside the hub. */
const TILE_INNER_PX = 40;
/** The tile's outer edge sits this far inside the disc rim. */
const RIM_INSET_PX = 7;
/** Gap between a selected tile and its neighbours' slots. */
const TILE_GAP_PX = 2;
const TILE_CORNER_PX = 8;
/** A tile never spans more than this, so two- and three-action rings keep a wedge. */
const MAX_TILE_DEG = 130;
/** A grown label keeps this far from every edge of its tile. */
const LABEL_MARGIN_PX = 4;
const GROW = 1.06;
/** The tile's slide between slots: a short chase that lands within a frame or two. */
const TILE_SLIDE_W = 140;

const COLOR = {

  edge: [150, 172, 222],
  flashEdge: [200, 212, 238],
  text: [154, 157, 164],
  icon: [116, 119, 127],
  textOff: [154, 157, 164],
  iconOff: [116, 119, 127],
  textOffAimed: [180, 182, 188],
  iconOffAimed: [139, 142, 150],
  white: [255, 255, 255],
} as const;
/**
 * The disc is slightly translucent, so the tile is a white wash over it rather
 * than a solid colour. The wash is applied as element opacity, so the stroke
 * that rounds its corners never doubles up over the fill.
 */
const TILE_ALPHA = 0.045;
const TILE_ALPHA_HI = 0.075;
const TILE_ALPHA_FLASH = 0.14;
const EDGE_ALPHA = 0.55;
const EDGE_ALPHA_HI = 0.75;
const EDGE_WIDTH = 1.5;

/**
 * Smallest disc and label radii per action count that keep labels clear of
 * each other, the hub and the rim. The ring grows past these when a label in
 * the system font does not fit its tile; see {@link fitRing}.
 */
const RING_DISC: Record<number, { Rd: number; ri: number }> = {
  1: { Rd: 108, ri: 68 },
  2: { Rd: 108, ri: 68 },
  3: { Rd: 116, ri: 68 },
  4: { Rd: 126, ri: 78 },
  5: { Rd: 126, ri: 78 },
  6: { Rd: 126, ri: 80 },
  7: { Rd: 138, ri: 92 },
  8: { Rd: 164, ri: 114 },
  9: { Rd: 168, ri: 120 },
  10: { Rd: 190, ri: 138 },
};

/** Label type steps down once the slots narrow; labels wrap past `wrap`. */
export function ringType(count: number) {
  if (count <= 7) return { font: 12, icon: 19, gap: 5, wrap: 84 };
  if (count === 8) return { font: 12, icon: 18, gap: 4, wrap: 78 };
  return { font: 11, icon: 16, gap: 4, wrap: 72 };
}

/** Clockwise degrees from twelve o'clock. */
export function pointerAngle(dx: number, dy: number): number {
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

/** The nearest slot by direction; slot 0 at twelve o'clock wraps the short way. */
export function slotOf(angle: number, count: number): number {
  return Math.round(angle / (360 / count)) % count;
}

const pt = (r: number, a: number): [number, number] => {
  const t = (a * Math.PI) / 180;
  return [r * Math.sin(t), -r * Math.cos(t)];
};
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const unwrap = (target: number, from: number) => {
  let t = target;
  while (t - from > 180) t -= 360;
  while (t - from < -180) t += 360;
  return t;
};
type Rgb = readonly number[];
const mix = (a: Rgb, b: Rgb, u: number) =>
  a.map((x, i) => Math.round(lerp(x, b[i]!, clamp(u))));
const rgba = (c: Rgb, alpha = 1) =>
  `rgba(${c[0]},${c[1]},${c[2]},${+alpha.toFixed(3)})`;

/**
 * Disc and label radii for these label boxes (measured unscaled, in the
 * selected weight). Every label, grown, must fit inside its own slot's tile
 * with a margin, and clear the hub; the disc then wraps the outermost label.
 */
export function fitRing(
  count: number,
  boxes: readonly { width: number; height: number }[],
): { Rd: number; ri: number } {
  const n = Math.min(Math.max(count, 1), RING_MAX_ACTIONS);
  const base = RING_DISC[n]!;
  const step = 360 / n;
  const half = Math.min(step, MAX_TILE_DEG) / 2;
  const sideClear = TILE_GAP_PX / 2 + LABEL_MARGIN_PX;
  const innerClear = Math.max(
    TILE_INNER_PX + LABEL_MARGIN_PX,
    HUB_RADIUS_PX + HUB_CLEARANCE_PX,
  );
  const fits = (ri: number) => {
    let outer = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i]!;
      const ang = i * step;
      const [cx, cy] = pt(ri, ang);
      const hw = (box.width * GROW) / 2;
      const hh = (box.height * GROW) / 2;
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const x = cx + sx * hw;
        const y = cy + sy * hh;
        const r = Math.hypot(x, y);
        if (r < innerClear) return null;
        outer = Math.max(outer, r);
        if (n === 1) continue;
        const offset = Math.abs(unwrap(pointerAngle(x, y), ang) - ang);
        if (offset >= half) return null;
        const toSide = r * Math.sin(((half - offset) * Math.PI) / 180);
        if (half - offset < 90 && toSide < sideClear) return null;
      }
    }
    return outer;
  };
  for (let ri = base.ri; ri <= base.ri + 120; ri += 1) {
    const outer = fits(ri);
    if (outer !== null) {
      return {
        ri,
        Rd: Math.max(base.Rd, Math.ceil(outer + RIM_INSET_PX + LABEL_MARGIN_PX)),
      };
    }
  }
  return base;
}

/** Annular sector with round corners from a stroke of width 2c in the fill colour. */
function wedgePath(R: number, r: number, g: number, a0: number, a1: number) {
  const po = (((g / 2) / R) * 180) / Math.PI;
  const pi = (((g / 2) / r) * 180) / Math.PI;
  let s = a0;
  let e = a1;
  if (e - s < 2 * pi + 1) {
    const m = (s + e) / 2;
    s = m - pi - 0.5;
    e = m + pi + 0.5;
  }
  const L = e - s > 180 ? 1 : 0;
  const [x1, y1] = pt(R, s + po);
  const [x2, y2] = pt(R, e - po);
  const [x3, y3] = pt(r, e - pi);
  const [x4, y4] = pt(r, s + pi);
  const f = (v: number) => v.toFixed(2);
  return `M${f(x1)} ${f(y1)}A${R} ${R} 0 ${L} 1 ${f(x2)} ${f(y2)}L${f(x3)} ${f(y3)}A${r} ${r} 0 ${L} 0 ${f(x4)} ${f(y4)}Z`;
}
function arcPath(r: number, a0: number, a1: number) {
  const [x0, y0] = pt(r, a0);
  const [x1, y1] = pt(r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

type Ease = (u: number) => number;
const easeOut: Ease = (u) => 1 - Math.pow(1 - u, 3);
const easeIn2: Ease = (u) => u * u;
const linear: Ease = (u) => u;

/** Damped spring on unit mass; spatial springs jump under reduced motion. */
class Spring {
  v = 0;
  to: number;
  constructor(
    public x: number,
    public k: number,
    public z: number,
    private readonly reduced: boolean,
  ) {
    this.to = x;
  }
  set(to: number) {
    this.to = to;
    if (this.reduced) {
      this.x = to;
      this.v = 0;
    }
    return this;
  }
  jump(x: number) {
    this.x = this.to = x;
    this.v = 0;
    return this;
  }
  kick(v: number) {
    if (!this.reduced) this.v += v;
    return this;
  }
  /**
   * Critically damped chase starting at full speed, advanced `head` ms inside
   * the event tick so the event frame already shows movement.
   */
  chase(to: number, w: number, head = 0) {
    this.k = w * w;
    this.z = 1;
    this.to = to;
    if (this.reduced) {
      this.x = to;
      this.v = 0;
      return this;
    }
    this.x = to - (to - this.x) * Math.exp((-w * head) / 1000);
    this.v = w * (to - this.x);
    return this;
  }
  tick(dt: number) {
    this.v +=
      (-this.k * (this.x - this.to) - 2 * this.z * Math.sqrt(this.k) * this.v) *
      dt;
    this.x += this.v * dt;
  }
}

/** Timed tween on the ring's clock, retargeted from its current value. */
class Tween {
  private a: number;
  private b: number;
  private t0 = 0;
  private d = 0;
  private ease: Ease = easeOut;
  constructor(
    public x: number,
    private readonly now: () => number,
  ) {
    this.a = x;
    this.b = x;
  }
  go(b: number, d: number, ease: Ease = easeOut, delay = 0) {
    this.a = this.x;
    this.b = b;
    this.t0 = this.now() + delay;
    this.d = d;
    this.ease = ease;
    return this;
  }
  jump(x: number) {
    this.x = this.a = this.b = x;
    this.d = 0;
    return this;
  }
  tick() {
    const t = this.now();
    if (t < this.t0) return;
    const u = this.d ? clamp((t - this.t0) / this.d) : 1;
    this.x = lerp(this.a, this.b, this.ease(u));
  }
}

export type RingCloseKind = "run" | "reject" | "cancel";

export type RingElements = {
  body: HTMLElement;
  base: HTMLElement;
  tile: SVGPathElement;
  edge: SVGPathElement;
  items: HTMLElement[];
  hub: HTMLElement;
  hubIcon: HTMLElement;
  /** The thread's name above the ring; it leaves with the labels. */
  title: HTMLElement | null;
};

type ItemState = { r: Spring; o: Tween; c: Tween; g: Spring };

/**
 * One opening of the ring. Construct it after React has rendered the ring's
 * elements; call {@link aim} on every pointer move and {@link close} once.
 * `onDone` fires when the close motion has finished, or at once from
 * {@link destroy}.
 */
export class RingPie {
  sel = -1;
  closing: RingCloseKind | null = null;
  readonly geometry: { Rd: number; ri: number };
  private t = 0;
  private last: number | null = null;
  private frame: number | null = null;
  private readonly springs: (Spring | Tween)[] = [];
  private queue: { t: number; fn: () => void }[] = [];
  private readonly step: number;
  private readonly scale: Spring;
  private readonly op: Tween;
  private readonly out: Tween;
  private readonly labOut: Tween;
  private readonly chosenOut: Tween;
  private readonly hubS: Spring;
  private readonly shake: Spring;
  private readonly bump: Spring;
  private readonly flash: Tween;
  private readonly items: ItemState[];
  private readonly tileAngle: Spring;
  private readonly tilePresence: Spring;
  private readonly tileFade: Tween;
  private tileShown = false;
  private finished = false;

  constructor(
    private readonly el: RingElements,
    private readonly disabled: readonly boolean[],
    private readonly reduced: boolean,
    private readonly onDone: () => void,
  ) {
    const n = el.items.length;
    this.step = 360 / Math.max(1, n);
    for (const item of el.items) item.style.fontWeight = "600";
    this.geometry = fitRing(
      n,
      el.items.map((item) => ({
        width: item.offsetWidth,
        height: item.offsetHeight,
      })),
    );
    for (const item of el.items) item.style.fontWeight = "";
    const { Rd, ri } = this.geometry;
    Object.assign(el.base.style, {
      left: `${-Rd}px`,
      top: `${-Rd}px`,
      width: `${2 * Rd}px`,
      height: `${2 * Rd}px`,
    });
    const now = () => this.t;
    const S = (x: number, k: number, z: number, spatial = true) => {
      const s = new Spring(x, k, z, reduced && spatial);
      this.springs.push(s);
      return s;
    };
    const T = (x: number) => {
      const tw = new Tween(x, now);
      this.springs.push(tw);
      return tw;
    };
    this.scale = S(0.72, 1400, 0.8).set(1);
    this.op = T(reduced ? 0 : 1);
    if (reduced) this.op.go(1, 30, linear);
    this.out = T(1);
    this.labOut = T(1);
    this.chosenOut = T(1);
    this.hubS = S(0.6, 1100, 0.75).set(1);
    this.shake = S(0, 3000, 0.35);
    this.bump = S(1, 1200, 0.55);
    this.flash = T(0);
    // The open stagger shares the five-action total, so ten open as fast as five.
    const stagger = n <= 5 ? 6 : (6 * 4) / (n - 1);
    this.items = el.items.map((_, i) => {
      const item: ItemState = {
        r: S(reduced ? ri : ri - 12, 900, 0.7),
        o: T(0),
        c: T(0),
        g: S(1, 2500, 1),
      };
      if (reduced) item.o.go(1, 40, linear, 30);
      else
        this.at(i * stagger, () => {
          item.r.set(ri);
          item.o.go(1, 50);
        });
      return item;
    });
    this.tileAngle = S(0, 1, 1);
    this.tilePresence = S(0, 1, 1);
    this.tileFade = T(0);
    this.render();
    this.frame = requestAnimationFrame(this.loop);
  }

  /** Pointer offset from the ring centre: distance in px and clockwise angle. */
  aim(dist: number, ang: number) {
    if (this.closing) return;
    const n = this.items.length;
    const sel = dist >= RING_DEAD_ZONE_PX ? slotOf(ang, n) : -1;
    if (sel === this.sel) return;
    this.sel = sel;
    this.items.forEach((item, i) => {
      const on = i === sel;
      item.c.jump(on ? 1 : 0);
      item.g.set(on && !this.disabled[i] && !this.reduced ? GROW : 1);
      if (on && !this.reduced) {
        item.o.jump(1);
        item.r.set(this.geometry.ri);
      }
      this.el.items[i]!.dataset.selected = on ? "true" : "false";
    });
    if (sel < 0) {
      // Entering the dead zone: the tile goes in the frame the label greys.
      this.tileShown = false;
      this.tilePresence.jump(0);
    } else if (this.tileShown) {
      // A landing chase, clamped so the event frame is already inside the slot.
      const to = unwrap(sel * this.step, this.tileAngle.x);
      this.tileAngle.chase(to, TILE_SLIDE_W, 18);
      const e = to - this.tileAngle.x;
      const m = 0.25 * this.step;
      if (Math.abs(e) > m) {
        this.tileAngle.x = to - Math.sign(e) * m;
        this.tileAngle.v = TILE_SLIDE_W * (to - this.tileAngle.x);
      }
    } else {
      // Leaving the dead zone: the tile fades in where it lands, without growing.
      this.tileShown = true;
      this.tileAngle.jump(sel * this.step);
      this.tilePresence.jump(1);
      this.tileFade.jump(this.reduced ? 1 : 0.4).go(1, 50, linear);
    }
    this.render();
  }

  /** Plays the run, reject or cancel motion, then calls `onDone`. */
  close(kind: RingCloseKind) {
    if (this.closing) return;
    this.closing = kind;
    const collapse = (delay: number) => {
      if (this.reduced) this.op.go(0, 40, linear, delay + 10);
      else this.out.go(0, 60, easeIn2, delay);
      this.at(delay + (this.reduced ? 40 : 60), () => this.finish());
    };
    if (kind === "run") {
      this.flash.jump(1).go(0, 160);
      this.bump.kick(1);
      this.labOut.go(0, 30, linear);
      this.chosenOut.go(0, 20, linear, 30);
      collapse(50);
    } else if (kind === "reject") {
      this.shake.kick(480);
      this.labOut.go(0, 30, linear, 40);
      this.chosenOut.go(0, 30, linear, 40);
      collapse(60);
    } else {
      this.tileShown = false;
      this.tilePresence.jump(0);
      for (const item of this.items) {
        item.c.jump(0);
        item.g.set(1);
      }
      this.labOut.go(0, 30, linear);
      this.chosenOut.go(0, 30, linear);
      collapse(30);
    }
    this.render();
  }

  /** Stops at once, for typing and window blur. */
  destroy() {
    this.finish();
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.onDone();
  }

  private at(ms: number, fn: () => void) {
    if (ms <= 0) fn();
    else this.queue.push({ t: this.t + ms, fn });
  }

  private loop = (now: number) => {
    if (this.finished) return;
    // The first frame advances one nominal frame; later ones the real interval.
    let rem = this.last === null ? 16 : Math.min(50, Math.max(0, now - this.last));
    this.last = now;
    while (rem > 1e-9 && !this.finished) {
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
    if (this.finished) return;
    this.render();
    this.frame = requestAnimationFrame(this.loop);
  };

  private render() {
    const el = this.el;
    const R = this.reduced;
    const { Rd } = this.geometry;
    const n = this.items.length;
    const s = R ? 1 : this.scale.x * this.out.x;
    el.body.style.transform = `translate(${this.shake.x.toFixed(2)}px, 0) scale(${s.toFixed(4)})`;
    // Opaque while any label shows; once they are gone the empty plate fades as it collapses.
    const bare =
      this.closing !== null && this.labOut.x < 0.01 && this.chosenOut.x < 0.01;
    el.body.style.opacity = (
      R ? this.op.x : Math.min(clamp((s - 0.1) / 0.3), bare ? this.out.x : 1)
    ).toFixed(3);

    const half = Math.min(this.step, MAX_TILE_DEG) / 2;
    const p = clamp(this.tilePresence.x, 0, 1.02);
    const inner = lerp(16, TILE_INNER_PX, p);
    const outer = lerp(30, Rd - RIM_INSET_PX, p);
    const c = clamp((outer - inner) / 2 - 0.5, 0, TILE_CORNER_PX);
    const show = this.tileShown && outer > 33 && this.sel >= 0;
    const group = el.tile.parentNode as SVGGElement | null;
    group?.setAttribute(
      "transform",
      `scale(${(this.closing === "run" ? this.bump.x : 1).toFixed(4)})`,
    );
    if (group) {
      group.style.opacity = show
        ? (this.tileFade.x * (this.closing ? this.chosenOut.x : 1)).toFixed(3)
        : "0";
    }
    if (show) {
      const a0 = this.tileAngle.x - half;
      const a1 = this.tileAngle.x + half;
      el.tile.setAttribute(
        "d",
        wedgePath(outer - c, inner + c, TILE_GAP_PX + 2 * c, a0, a1),
      );
      el.tile.style.strokeWidth = (2 * c).toFixed(2);
      const hi = n >= 8;
      el.tile.setAttribute("fill", "#fff");
      el.tile.setAttribute("stroke", "#fff");
      el.tile.style.opacity = lerp(
        hi ? TILE_ALPHA_HI : TILE_ALPHA,
        TILE_ALPHA_FLASH,
        clamp(this.flash.x),
      ).toFixed(3);
      const off = this.disabled[this.sel] === true;
      const ea = off ? 0 : clamp((p - 0.6) / 0.4);
      el.edge.style.display = ea > 0 ? "" : "none";
      if (ea > 0) {
        const er = outer - EDGE_WIDTH / 2 - 0.5;
        const ed = (((0.6 * c + TILE_GAP_PX / 2) / er) * 180) / Math.PI;
        el.edge.setAttribute("d", arcPath(er, a0 + ed, a1 - ed));
        el.edge.setAttribute(
          "stroke",
          rgba(
            mix(COLOR.edge, COLOR.flashEdge, this.flash.x),
            (hi ? EDGE_ALPHA_HI : EDGE_ALPHA) * ea,
          ),
        );
        el.edge.style.strokeWidth = String(EDGE_WIDTH);
      }
    }

    this.items.forEach((item, i) => {
      const node = el.items[i]!;
      const ci = clamp(item.c.x);
      const mine = this.closing !== null && i === this.sel;
      const runBump = this.closing === "run" && i === this.sel ? this.bump.x : 1;
      const [x, y] = pt(item.r.x * runBump, i * this.step);
      const grow = R ? "" : ` scale(${item.g.x.toFixed(4)})`;
      node.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) translate(-50%, -50%)${grow}`;
      node.style.opacity = (
        item.o.x * (mine ? this.chosenOut.x : this.labOut.x)
      ).toFixed(3);
      const icon = node.firstElementChild as HTMLElement | null;
      const note = node.querySelector<HTMLElement>(".qa-ring-note");
      if (this.disabled[i]) {
        node.style.color = rgba(mix(COLOR.textOff, COLOR.textOffAimed, ci), lerp(0.45, 1, ci));
        if (icon) icon.style.color = rgba(mix(COLOR.iconOff, COLOR.iconOffAimed, ci), lerp(0.45, 1, ci));
        if (note) note.style.opacity = ci.toFixed(3);
      } else {
        node.style.color = rgba(mix(COLOR.text, COLOR.white, ci));
        if (icon) icon.style.color = rgba(mix(COLOR.icon, COLOR.white, ci));
        node.style.fontWeight = ci > 0.5 ? "600" : "";
      }
    });
    el.hub.style.transform = `scale(${(R ? 1 : this.hubS.x).toFixed(4)})`;
    el.hubIcon.style.opacity = this.labOut.x.toFixed(3);
    if (el.title) el.title.style.opacity = this.labOut.x.toFixed(3);
  }
}
