import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "@/components/ui/icon";
import {
  RING_MAX_ACTIONS,
  RingPie,
  pointerAngle,
  ringType,
  type RingCloseKind,
} from "./ring-pie";

export type HoldPieAction = {
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
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

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type OpenRing = {
  key: number;
  x: number;
  y: number;
  title: string | null;
  actions: HoldPieAction[];
};

/** Space between the ring's rim and the thread name. */
const TITLE_GAP_PX = 10;

/**
 * Hold Option anywhere and the ring opens centred exactly on the pointer. A
 * 200ms hold keeps Option-letter accents (⌥e) intact. Direction selects;
 * the centre is a dead zone. Releasing Option runs the selection, or closes
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
  onRun: (id: string) => void;
  onUnavailable: (action: HoldPieAction) => void;
}) {
  const pointer = usePointerPosition();
  const [ring, setRing] = useState<OpenRing | null>(null);
  const [dim, setDim] = useState<"off" | "on" | "instant">("off");
  const engineRef = useRef<RingPie | null>(null);
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
  const edgeRef = useRef<SVGPathElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  const hubIconRef = useRef<HTMLSpanElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useLayoutEffect(() => {
    if (!ring) return;
    const body = bodyRef.current;
    const base = baseRef.current;
    const tile = tileRef.current;
    const edge = edgeRef.current;
    const hub = hubRef.current;
    const hubIcon = hubIconRef.current;
    const items = itemRefs.current
      .slice(0, ring.actions.length)
      .filter((item): item is HTMLDivElement => item !== null);
    if (!body || !base || !tile || !edge || !hub || !hubIcon) return;
    const key = ring.key;
    const engine = new RingPie(
      { body, base, tile, edge, items, hub, hubIcon, title: titleRef.current },
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
    if (titleNode) {
      const { Rd } = engine.geometry;
      const above = ring.y - Rd - TITLE_GAP_PX - titleNode.offsetHeight >= 8;
      titleNode.style.top = above
        ? `${-Rd - TITLE_GAP_PX - titleNode.offsetHeight}px`
        : `${Rd + TITLE_GAP_PX}px`;
    }
    const { x, y } = pointer.current;
    engine.aim(Math.hypot(x - ring.x, y - ring.y), pointerAngle(x - ring.x, y - ring.y));
    return () => {
      if (engineRef.current === engine) engineRef.current = null;
      engine.destroy();
    };
  }, [pointer, ring?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Removes the ring in the same frame, for typing and window blur. */
  const vanish = useCallback(() => {
    engineRef.current?.destroy();
    engineRef.current = null;
    setRing(null);
    setDim((current) => (current === "off" ? current : "instant"));
  }, []);

  const closeRing = useCallback((kind: RingCloseKind) => {
    const engine = engineRef.current;
    if (!engine || engine.closing) return;
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
      const dx = event.clientX - ring.x;
      const dy = event.clientY - ring.y;
      engineRef.current?.aim(Math.hypot(dx, dy), pointerAngle(dx, dy));
    };
    const press = (event: PointerEvent) => {
      if (
        baseRef.current &&
        event.target instanceof Node &&
        baseRef.current.contains(event.target)
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
          // A ring still closing makes way for the new one.
          engineRef.current?.destroy();
          keyRef.current += 1;
          setRing({
            key: keyRef.current,
            x: pointer.current.x,
            y: pointer.current.y,
            title: latestTitleRef.current,
            actions: list,
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
                <path
                  ref={edgeRef}
                  className="qa-ring-edge"
                  fill="none"
                  strokeLinecap="round"
                />
              </g>
            </svg>
            {ring.actions.map((action, index) => (
              <div
                key={action.id}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                className="qa-ring-item"
                role="menuitem"
                aria-disabled={action.disabled ? "true" : undefined}
                data-selected="false"
              >
                <Icon name={action.icon} />
                <span className="qa-ring-label">{action.label}</span>
                {action.disabled ? (
                  <span className="qa-ring-note">Unavailable</span>
                ) : null}
              </div>
            ))}
            {ring.title ? (
              <div ref={titleRef} className="qa-ring-title">
                {ring.title}
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
