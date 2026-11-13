import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "@/components/ui/icon";
import {
  RING_DEAD_ZONE_PX,
  RING_MAX_ACTIONS,
  RingPie,
  pointerAngle,
  ringType,
  type RingCloseKind,
} from "./ring-pie";
import { RingBand } from "./ring-band";

/** One choice in an action's outer band, such as a Snooze wake time. */
export type HoldPieOption = {
  id: string;
  label: string;
  /** A second line under the label, such as the wake time. */
  detail: string;
  /** Releasing on the parent action takes this option, so the band lights it. */
  isDefault?: boolean;
};

export type HoldPieAction = {
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
  /**
   * Choices for an outer band that grows out of this action's slice once the
   * action is selected. Called as the ring opens, so time-based choices are
   * current. Only the first such action in a ring gets a band.
   */
  options?: () => readonly HoldPieOption[];
};

const HOLD_OPTION_DELAY_MS = 200;
/** Keys that leave the open ring alone: modifiers pressed alongside Option. */
const PASSIVE_KEYS = new Set(["Shift", "Meta", "Control", "CapsLock", "Alt"]);

/**
 * Tracks the pointer so the ring opens where the hand already is. Presses
 * update it too: a click without a preceding move (a trackpad tap) still
 * counts as the pointer's location.
 */
function usePointerPosition() {
  const point = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const track = (event: { clientX: number; clientY: number }) => {
      point.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", track, { passive: true });
    window.addEventListener("pointerdown", track, {
      passive: true,
      capture: true,
    });
    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerdown", track, { capture: true });
    };
  }, []);
  return point;
}

/**
 * The ring acts on the open thread, so it opens only over a thread pane's
 * timeline and composer (BB's `[data-thread-window]`), never over the
 * sidebar, the title bar, or the window controls. The check hit-tests the
 * topmost element under the pointer, skipping this plugin's own overlay so a
 * ring still closing there does not hide the pane beneath it.
 */
function isOverThreadPane(x: number, y: number): boolean {
  if (typeof document.elementsFromPoint !== "function") return false;
  for (const element of document.elementsFromPoint(x, y)) {
    if (element.closest('[data-bb-plugin="quick-actions"]')) continue;
    return element.closest("[data-thread-window]") !== null;
  }
  return false;
}

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type OpenRing = {
  key: number;
  x: number;
  y: number;
  title: string | null;
  actions: HoldPieAction[];
  /** The action with an outer band, and the band's choices as the ring opened. */
  band: { parent: number; options: readonly HoldPieOption[] } | null;
};

function bandFor(actions: readonly HoldPieAction[]): OpenRing["band"] {
  const parent = actions.findIndex((action) => action.options && !action.disabled);
  if (parent < 0) return null;
  const options = actions[parent]!.options!();
  return options.length > 0 ? { parent, options } : null;
}

/**
 * The band extends once the pointer is this far from the centre with the
 * parent selected: a little past the hub, so the selection settles before the
 * band moves, and it stays open until the parent is no longer selected.
 */
const BAND_OPEN_PX = RING_DEAD_ZONE_PX + 12;
/** The chevron sits this far inside the rim, beyond the parent's label. */
const MORE_INSET_PX = 13;

/**
 * Aims the ring and its band at the pointer. On the band, the parent action
 * stays selected and the band selects by angle. Elsewhere the ring aims as
 * usual; once the parent is selected and the pointer is past BAND_OPEN_PX the
 * band extends, lighting the default option that releasing would take, and
 * selecting anything else folds it back.
 */
function steer(
  engine: RingPie,
  band: RingBand | null,
  open: OpenRing,
  dist: number,
  ang: number,
) {
  if (engine.closing) return;
  if (!band || !open.band) {
    engine.aim(dist, ang);
    return;
  }
  const { ri } = engine.geometry;
  const parent = open.band.parent;
  const onBand = () => band.extended && dist >= band.R0 - 2 && band.contains(ang);
  if (onBand()) {
    engine.aim(ri, (parent * 360) / open.actions.length);
    band.aim(ang);
    return;
  }
  engine.aim(dist, ang);
  if (engine.sel === parent) {
    if (dist >= BAND_OPEN_PX && !band.extended) band.extend();
    band.aim(!band.extended ? null : onBand() ? ang : band.defaultAngle);
  } else {
    band.aim(null);
    if (band.extended) band.retract();
  }
}

/** Space between the ring's rim and the thread name. */
const TITLE_GAP_PX = 10;

/**
 * Hold Option over a thread pane and the ring opens centred exactly on the
 * pointer. A 200ms hold keeps Option-letter accents (⌥e) intact. Direction selects;
 * the centre is a dead zone. An action with options (Snooze) grows an outer
 * band of them past its label. Releasing Option runs the selection, or closes
 * from the centre; Escape and a press outside the ring cancel; any other
 * keypress removes it in the same frame so typing is never interrupted.
 * While the ring is open the window dims slightly behind it.
 */
export function HoldOptionPie({
  title,
  actions,
  canOpen,
  busy,
  onRun,
  onUnavailable,
}: {
  /** The thread the actions apply to, named above the ring. */
  title: string | null;
  actions: readonly HoldPieAction[];
  canOpen: boolean;
  /** An action is still running; the ring cancels instead of running another. */
  busy: boolean;
  /** Runs an action, with the band option chosen for it, if any. */
  onRun: (id: string, optionId?: string) => void;
  onUnavailable: (action: HoldPieAction) => void;
}) {
  const pointer = usePointerPosition();
  const [ring, setRing] = useState<OpenRing | null>(null);
  const [dim, setDim] = useState<"off" | "on" | "instant">("off");
  const engineRef = useRef<RingPie | null>(null);
  const bandRef = useRef<RingBand | null>(null);
  const keyRef = useRef(0);
  const ringRef = useRef(ring);
  ringRef.current = ring;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const latestTitleRef = useRef(title);
  latestTitleRef.current = title;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  const bodyRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLDivElement>(null);
  const tileRef = useRef<SVGPathElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  const hubIconRef = useRef<HTMLSpanElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const titlePlateRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const bandSvgRef = useRef<SVGSVGElement>(null);
  const bandOutlineRef = useRef<SVGPathElement>(null);
  const bandRimRef = useRef<SVGPathElement>(null);
  const bandPlateRef = useRef<SVGPathElement>(null);
  const bandTileGroupRef = useRef<SVGGElement>(null);
  const bandTileRef = useRef<SVGPathElement>(null);
  const bandItemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const moreRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!ring) return;
    const body = bodyRef.current;
    const base = baseRef.current;
    const tile = tileRef.current;
    const hub = hubRef.current;
    const hubIcon = hubIconRef.current;
    const items = itemRefs.current
      .slice(0, ring.actions.length)
      .filter((item): item is HTMLDivElement => item !== null);
    if (!body || !base || !tile || !hub || !hubIcon) return;
    const key = ring.key;
    const engine = new RingPie(
      { body, base, tile, items, hub, hubIcon, title: titleRef.current },
      ring.actions.map((action) => action.disabled === true),
      prefersReducedMotion(),
      () => {
        if (engineRef.current === engine) engineRef.current = null;
        setRing((current) => (current?.key === key ? null : current));
      },
    );
    engineRef.current = engine;
    // The name sits above the rim, or below it when the ring opens near the top.
    const titleNode = titleRef.current;
    const plate = titlePlateRef.current;
    if (titleNode && plate) {
      const { Rd } = engine.geometry;
      const above = ring.y - Rd - TITLE_GAP_PX - plate.offsetHeight >= 8;
      titleNode.style.top = above
        ? `${-Rd - TITLE_GAP_PX - plate.offsetHeight}px`
        : `${Rd + TITLE_GAP_PX}px`;
    }
    // An action with options grows its band out of its own slice.
    const spec = ring.band;
    const more = moreRef.current;
    if (spec && more) {
      // From the parent's label out to just inside the rim, along its angle.
      const { Rd, ri } = engine.geometry;
      const angle = (spec.parent * 360) / ring.actions.length;
      const reach = Rd - MORE_INSET_PX - ri;
      const t = (angle * Math.PI) / 180;
      more.style.setProperty("--qa-more-x", `${(reach * Math.sin(t)).toFixed(2)}px`);
      more.style.setProperty("--qa-more-y", `${(-reach * Math.cos(t)).toFixed(2)}px`);
      more.style.setProperty("--qa-more-turn", `${(angle - 90).toFixed(2)}deg`);
    }
    const svg = bandSvgRef.current;
    const outline = bandOutlineRef.current;
    const rim = bandRimRef.current;
    const fill = bandPlateRef.current;
    const tileGroup = bandTileGroupRef.current;
    const bandTile = bandTileRef.current;
    const band =
      spec && svg && outline && rim && fill && tileGroup && bandTile
        ? new RingBand(
            {
              svg,
              outline,
              rim,
              plate: fill,
              tileGroup,
              tile: bandTile,
              items: bandItemRefs.current
                .slice(0, spec.options.length)
                .filter((item): item is HTMLDivElement => item !== null),
              title: plate,
              more,
            },
            (spec.parent * 360) / ring.actions.length,
            180 / ring.actions.length,
            Math.max(0, spec.options.findIndex((option) => option.isDefault)),
            engine.geometry.Rd,
            prefersReducedMotion(),
          )
        : null;
    bandRef.current = band;
    const { x, y } = pointer.current;
    steer(engine, band, ring, Math.hypot(x - ring.x, y - ring.y), pointerAngle(x - ring.x, y - ring.y));
    return () => {
      if (engineRef.current === engine) engineRef.current = null;
      if (bandRef.current === band) bandRef.current = null;
      engine.destroy();
      band?.destroy();
    };
  }, [pointer, ring?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Removes the ring in the same frame, for typing and window blur. */
  const vanish = useCallback(() => {
    engineRef.current?.destroy();
    engineRef.current = null;
    bandRef.current?.destroy();
    bandRef.current = null;
    setRing(null);
    setDim((current) => (current === "off" ? current : "instant"));
  }, []);

  const closeRing = useCallback((kind: RingCloseKind) => {
    const engine = engineRef.current;
    if (!engine || engine.closing) return;
    // A run confirms its band option itself; any other close folds the band.
    if (kind !== "run") bandRef.current?.retract();
    engine.close(kind);
    setDim("off");
  }, []);

  /**
   * Runs the selection, or cancels when nothing is selected. An unavailable
   * selection shakes the ring and reports why instead of running.
   */
  const commit = useCallback(() => {
    const engine = engineRef.current;
    const open = ringRef.current;
    if (!engine || !open || engine.closing) return;
    const band = bandRef.current;
    const option = band && open.band && band.sel >= 0 ? open.band.options[band.sel] : undefined;
    if (option && open.band) {
      if (busyRef.current) {
        closeRing("cancel");
        return;
      }
      band!.confirm();
      closeRing("run");
      onRunRef.current(open.actions[open.band.parent]!.id, option.id);
      return;
    }
    const action = engine.sel >= 0 ? open.actions[engine.sel] : undefined;
    if (!action || busyRef.current) {
      closeRing("cancel");
      return;
    }
    if (action.disabled) {
      closeRing("reject");
      onUnavailableRef.current(action);
      return;
    }
    closeRing("run");
    onRunRef.current(action.id);
  }, [closeRing]);

  useEffect(() => {
    if (!ring) return;
    const track = (event: PointerEvent) => {
      const engine = engineRef.current;
      if (!engine) return;
      const dx = event.clientX - ring.x;
      const dy = event.clientY - ring.y;
      steer(engine, bandRef.current, ring, Math.hypot(dx, dy), pointerAngle(dx, dy));
    };
    const press = (event: PointerEvent) => {
      // A press on the disc or the open band runs the selection on click.
      const target = event.target;
      if (
        target instanceof Node &&
        (baseRef.current?.contains(target) || bandSvgRef.current?.contains(target))
      ) {
        return;
      }
      closeRing("cancel");
    };
    window.addEventListener("pointermove", track, { passive: true });
    window.addEventListener("pointerdown", press, true);
    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerdown", press, true);
    };
  }, [closeRing, ring]);

  useEffect(() => {
    if (!canOpen) {
      vanish();
      return;
    }
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let held = false;
    const clearHold = () => {
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = null;
    };
    const isOpen = () => engineRef.current !== null && !engineRef.current.closing;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Alt" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        if (held || event.repeat) return;
        // A dialog owns the keyboard while it is open.
        if (
          document.querySelector(
            '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
          )
        ) {
          return;
        }
        held = true;
        clearHold();
        holdTimer = setTimeout(() => {
          holdTimer = null;
          if (!held) return;
          const list = actionsRef.current.slice(0, RING_MAX_ACTIONS);
          if (list.length === 0) return;
          const { x, y } = pointer.current;
          if (!isOverThreadPane(x, y)) return;
          // A ring still closing makes way for the new one.
          engineRef.current?.destroy();
          keyRef.current += 1;
          setRing({
            key: keyRef.current,
            x,
            y,
            title: latestTitleRef.current,
            actions: list,
            band: bandFor(list),
          });
          setDim("on");
        }, HOLD_OPTION_DELAY_MS);
        return;
      }
      if (!held && !isOpen()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        held = false;
        clearHold();
        closeRing("cancel");
        return;
      }
      // Chords with Option held are common; modifiers alone never dismiss.
      if (PASSIVE_KEYS.has(event.key)) return;
      held = false;
      clearHold();
      // Typing: get out of the way without any motion over the composer.
      if (isOpen()) vanish();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Alt") return;
      held = false;
      clearHold();
      if (isOpen()) commit();
    };
    const onBlur = () => {
      held = false;
      clearHold();
      if (engineRef.current) vanish();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      clearHold();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [canOpen, closeRing, commit, pointer, vanish]);

  const type = ringType(ring?.actions.length ?? 5);
  return (
    <div
      className="qa-hold"
      data-bb-plugin-root=""
      data-bb-plugin="quick-actions"
      data-trigger="hold-option"
      data-open={ring ? "true" : "false"}
    >
      <div className="qa-dim" data-state={dim} aria-hidden="true" />
      {ring ? (
        <div
          key={ring.key}
          className="qa-ring"
          role="menu"
          aria-label={ring.title ? `Quick actions for ${ring.title}` : "Quick actions"}
          style={
            {
              left: `${ring.x}px`,
              top: `${ring.y}px`,
              "--qa-ring-font": `${type.font}px`,
              "--qa-ring-icon": `${type.icon}px`,
              "--qa-ring-gap": `${type.gap}px`,
              "--qa-ring-wrap": `${type.wrap}px`,
            } as CSSProperties
          }
        >
          <div ref={bodyRef} className="qa-ring-body">
            <div ref={baseRef} className="qa-ring-base" onClick={commit} />
            <svg className="qa-ring-tiles" viewBox="-300 -300 600 600" aria-hidden="true">
              <g>
                <path ref={tileRef} className="qa-ring-tile" />
              </g>
            </svg>
            {ring.band ? (
              <svg
                ref={bandSvgRef}
                className="qa-band"
                viewBox="-300 -300 600 600"
                aria-hidden="true"
              >
                <g className="qa-band-plate" onClick={commit}>
                  <path ref={bandOutlineRef} className="qa-band-outline" />
                  <path ref={bandRimRef} className="qa-band-rim" />
                  <path ref={bandPlateRef} className="qa-band-fill" />
                </g>
                <g ref={bandTileGroupRef}>
                  <path ref={bandTileRef} className="qa-ring-tile" />
                </g>
              </svg>
            ) : null}
            {ring.actions.map((action, index) => (
              <div
                key={action.id}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                className="qa-ring-item"
                role="menuitem"
                aria-disabled={action.disabled ? "true" : undefined}
                aria-haspopup={ring.band?.parent === index ? "menu" : undefined}
                data-selected="false"
              >
                <Icon name={action.icon} />
                <span className="qa-ring-label">{action.label}</span>
                {action.disabled ? (
                  <span className="qa-ring-note">Unavailable</span>
                ) : null}
                {ring.band?.parent === index ? (
                  // Points outward to the band of options this action opens.
                  <span ref={moreRef} className="qa-ring-more" aria-hidden="true">
                    <Icon name="ChevronRight" />
                  </span>
                ) : null}
              </div>
            ))}
            {ring.band ? (
              <div
                className="qa-band-items"
                role="menu"
                aria-label={`${ring.actions[ring.band.parent]!.label} until`}
              >
                {ring.band.options.map((option, index) => (
                  <div
                    key={option.id}
                    ref={(node) => {
                      bandItemRefs.current[index] = node;
                    }}
                    className="qa-ring-item"
                    role="menuitem"
                    data-selected="false"
                  >
                    <span className="qa-ring-label">{option.label}</span>
                    <span className="qa-ring-time">{option.detail}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {ring.title ? (
              // The ring fades this anchor with its labels; the band fades the
              // plate inside it while covering the top of the ring.
              <div ref={titleRef} className="qa-title-anchor">
                <div ref={titlePlateRef} className="qa-ring-title">
                  {ring.title}
                </div>
              </div>
            ) : null}
            <div ref={hubRef} className="qa-ring-hub" aria-hidden="true">
              <span ref={hubIconRef} className="qa-ring-x">
                <Icon name="X" />
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
