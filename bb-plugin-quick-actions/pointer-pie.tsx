import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
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

/** One choice in an action's outer band, such as a Snooze preset. */
export type PieOption = {
  id: string;
  label: string;
  /** Releasing on the parent action takes this option, so the band lights it. */
  isDefault?: boolean;
};

export type PieAction = {
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
  /**
   * Choices for an outer band that grows out of this action's slice once the
   * action is selected. Called as the ring opens, so the choices are current.
   */
  options?: () => readonly PieOption[];
};

const HOLD_OPTION_DELAY_MS = 200;
/**
 * A right-click on a split pane that isn't focused focuses it, and the ring
 * waits for the open thread to follow before it opens. When the thread stays
 * the same (both panes show it) the ring opens after this grace period, and a
 * right-click whose thread never becomes ready is dropped after the limit.
 */
const PANE_SWITCH_GRACE_MS = 250;
const PANE_SWITCH_LIMIT_MS = 1500;
/** A context menu this far from its press came from somewhere else, such as the keyboard. */
const CONTEXT_PRESS_SLOP_PX = 4;
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

/**
 * Right-clicks here keep the browser's own menu: fields keep spelling
 * suggestions and paste, links keep Open in Browser and Copy Link, and media
 * keeps Copy Image.
 */
const NATIVE_MENU_TARGETS = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  "a[href]",
  "img",
  "video",
  "audio",
].join(", ");

function keepsNativeMenu(target: EventTarget | null): boolean {
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!element) return true;
  return (
    (element instanceof HTMLElement && element.isContentEditable) ||
    element.closest(NATIVE_MENU_TARGETS) !== null
  );
}

/** The document selection at a right-click's press, before the browser reacts to it. */
type SelectionSnapshot = { text: string; ranges: Range[] };

function snapshotSelection(): SelectionSnapshot | null {
  const selection = document.getSelection();
  if (!selection) return null;
  const ranges: Range[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    ranges.push(selection.getRangeAt(index).cloneRange());
  }
  return { text: selection.toString(), ranges };
}

/** Whether the pointer is on selected text, where the menu's Copy is the point. */
function selectionContains(snapshot: SelectionSnapshot | null, x: number, y: number) {
  if (!snapshot || snapshot.text.length === 0) return false;
  return snapshot.ranges.some((range) => {
    if (range.collapsed || typeof range.getClientRects !== "function") return false;
    return Array.from(range.getClientRects()).some(
      (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
    );
  });
}

/**
 * On macOS, Chromium selects the word under a right-click before the menu
 * event arrives. The ring replaces that menu, so it puts the selection back.
 */
function restoreSelection(snapshot: SelectionSnapshot | null) {
  const selection = document.getSelection();
  if (!snapshot || !selection || selection.toString() === snapshot.text) return;
  selection.removeAllRanges();
  for (const range of snapshot.ranges) selection.addRange(range);
}

/** A press that may become a right-click: the secondary button, or Control-click. */
function isContextPress(event: PointerEvent) {
  return event.button === 2 || (event.button === 0 && event.ctrlKey);
}

/** A split pane BB has not focused; outside split view every pane counts as focused. */
function inUnfocusedPane(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return target.closest("[data-split-pane-id]")?.getAttribute("data-focused") === "false";
}

type ContextPress = {
  x: number;
  y: number;
  button: number;
  selection: SelectionSnapshot | null;
  /** BB focuses an unfocused pane on this press, so its thread is about to change. */
  switchesPane: boolean;
  threadKey: string;
};

type PendingOpen = { x: number; y: number; threadKey: string; at: number };

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type OpenRing = {
  key: number;
  /** What opened the ring: holding Option, or a right-click. */
  source: "hold" | "context";
  /** The button of the right-click that opened the ring, while still held. */
  releaseButton: number | null;
  x: number;
  y: number;
  title: string | null;
  actions: PieAction[];
  /** Each action with an outer band, and its choices as the ring opened. */
  bands: BandSpec[];
};

type BandSpec = { parent: number; options: readonly PieOption[] };

function bandsFor(actions: readonly PieAction[]): BandSpec[] {
  return actions.flatMap((action, parent) => {
    if (!action.options || action.disabled) return [];
    const options = action.options();
    return options.length > 0 ? [{ parent, options }] : [];
  });
}

/** The DOM each band draws into, filled in by the ring's render. */
type BandNodes = {
  svg: SVGSVGElement | null;
  outline: SVGPathElement | null;
  rim: SVGPathElement | null;
  plate: SVGPathElement | null;
  tileGroup: SVGGElement | null;
  tile: SVGPathElement | null;
  items: (HTMLDivElement | null)[];
  more: HTMLSpanElement | null;
  /** This band's own fade around the thread name plate. */
  titleFade: HTMLDivElement | null;
};

const emptyBandNodes = (): BandNodes => ({
  svg: null,
  outline: null,
  rim: null,
  plate: null,
  tileGroup: null,
  tile: null,
  items: [],
  more: null,
  titleFade: null,
});

/** The chevron sits this far inside the rim, beyond the parent's label. */
const MORE_INSET_PX = 13;

/**
 * Aims the ring and its bands at the pointer. On an open band, its parent
 * action stays selected and the band selects by angle. Elsewhere the ring
 * aims as usual; as soon as an action with a band is selected its band
 * extends, lighting the default option that releasing would take, and
 * selecting anything else folds it back. At most one band is open, since only
 * the selected action's band extends.
 */
function steer(
  engine: RingPie,
  bands: readonly RingBand[],
  open: OpenRing,
  dist: number,
  ang: number,
) {
  if (engine.closing) return;
  if (bands.length === 0) {
    engine.aim(dist, ang);
    return;
  }
  const { ri } = engine.geometry;
  const onBand = (band: RingBand) => band.extended && dist >= band.R0 - 2 && band.contains(ang);
  const held = bands.findIndex(onBand);
  if (held >= 0) {
    engine.aim(ri, (open.bands[held]!.parent * 360) / open.actions.length);
    bands[held]!.aim(ang);
    return;
  }
  engine.aim(dist, ang);
  bands.forEach((band, index) => {
    const spec = open.bands[index]!;
    if (engine.sel === spec.parent) {
      if (!band.extended) band.extend();
      // Off the band, light what releasing takes: the default option, if any.
      const lit = spec.options.some((option) => option.isDefault);
      band.aim(!band.extended ? null : lit ? band.defaultAngle : null);
    } else {
      band.aim(null);
      if (band.extended) band.retract();
    }
  });
}

/** Space between the ring's rim and the thread name. */
const TITLE_GAP_PX = 10;

/**
 * A ring of thread actions centred exactly on the pointer over a thread pane,
 * opened by holding Option, by right-clicking, or both.
 *
 * Holding Option for 200ms opens it, which keeps Option-letter accents (⌥e)
 * intact, and releasing Option runs the selection or closes from the centre.
 * A right-click opens it in place of the browser's menu, except on fields,
 * links, media, selected text, and anything with its own menu. Releasing the
 * button outside the hub runs the selection; releasing in the hub leaves the
 * ring open for a click on the disc, and another right-click in the hub
 * closes it.
 *
 * Direction selects; the centre is a dead zone. An action with options
 * (Snooze) grows an outer band of them past its label. Escape and a press
 * outside the ring cancel; any other keypress removes it in the same frame so
 * typing is never interrupted. While the ring is open the window dims
 * slightly behind it.
 */
export function PointerPie({
  title,
  threadKey,
  actions,
  canOpen,
  holdOption,
  rightClick,
  busy,
  onRun,
  onUnavailable,
}: {
  /** The thread the actions apply to, named above the ring. */
  title: string | null;
  /** Identifies that thread, so a right-click can wait for a pane switch. */
  threadKey: string;
  /** Holding Option opens the ring. */
  holdOption: boolean;
  /** Right-clicking a thread pane opens the ring. */
  rightClick: boolean;
  actions: readonly PieAction[];
  canOpen: boolean;
  /** An action is still running; the ring cancels instead of running another. */
  busy: boolean;
  /** Runs an action, with the band option chosen for it, if any. */
  onRun: (id: string, optionId?: string) => void;
  onUnavailable: (action: PieAction) => void;
}) {
  const pointer = usePointerPosition();
  const [ring, setRing] = useState<OpenRing | null>(null);
  const [dim, setDim] = useState<"off" | "on" | "instant">("off");
  const engineRef = useRef<RingPie | null>(null);
  const bandsRef = useRef<RingBand[]>([]);
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
  const canOpenRef = useRef(canOpen);
  canOpenRef.current = canOpen;
  const threadKeyRef = useRef(threadKey);
  threadKeyRef.current = threadKey;
  const holdOptionRef = useRef(holdOption);
  holdOptionRef.current = holdOption;
  /** The right-click press that has not yet produced a menu event. */
  const contextPressRef = useRef<ContextPress | null>(null);
  /** The button of a right-click still held down, whose release can run the ring. */
  const heldButtonRef = useRef<number | null>(null);
  const pendingOpenRef = useRef<PendingOpen | null>(null);
  /**
   * The current right-click closed the ring, so its menu event shows nothing.
   * The right-click press listener clears it first on every press: it is
   * registered at mount, before the open ring's own press listener sets it.
   */
  const swallowMenuRef = useRef(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLDivElement>(null);
  const tileRef = useRef<SVGPathElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  const hubIconRef = useRef<HTMLSpanElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const titlePlateRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const bandNodesRef = useRef<BandNodes[]>([]);
  const bandNodes = (index: number) =>
    (bandNodesRef.current[index] ??= emptyBandNodes());

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
    // Each action with options grows its band out of its own slice.
    const { Rd, ri } = engine.geometry;
    const slot = 360 / ring.actions.length;
    const bands = ring.bands.flatMap((spec, index) => {
      const nodes = bandNodes(index);
      const angle = spec.parent * slot;
      if (nodes.more) {
        // From the parent's label out to just inside the rim, along its angle.
        const reach = Rd - MORE_INSET_PX - ri;
        const t = (angle * Math.PI) / 180;
        nodes.more.style.setProperty("--qa-more-x", `${(reach * Math.sin(t)).toFixed(2)}px`);
        nodes.more.style.setProperty("--qa-more-y", `${(-reach * Math.cos(t)).toFixed(2)}px`);
        nodes.more.style.setProperty("--qa-more-turn", `${(angle - 90).toFixed(2)}deg`);
      }
      const { svg, outline, rim, plate: fill, tileGroup, tile: bandTile } = nodes;
      if (!svg || !outline || !rim || !fill || !tileGroup || !bandTile) return [];
      return [
        new RingBand(
          {
            svg,
            outline,
            rim,
            plate: fill,
            tileGroup,
            tile: bandTile,
            items: nodes.items
              .slice(0, spec.options.length)
              .filter((item): item is HTMLDivElement => item !== null),
            // Without a title the fade wraps nothing, and fades nothing.
            title: nodes.titleFade,
            more: nodes.more,
          },
          angle,
          slot / 2,
          Math.max(0, spec.options.findIndex((option) => option.isDefault)),
          Rd,
          prefersReducedMotion(),
        ),
      ];
    });
    bandsRef.current = bands;
    const { x, y } = pointer.current;
    steer(engine, bands, ring, Math.hypot(x - ring.x, y - ring.y), pointerAngle(x - ring.x, y - ring.y));
    return () => {
      if (engineRef.current === engine) engineRef.current = null;
      if (bandsRef.current === bands) bandsRef.current = [];
      engine.destroy();
      for (const band of bands) band.destroy();
    };
  }, [pointer, ring?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Opens a ring of the current actions at a point, replacing one still closing. */
  const openAt = useCallback((x: number, y: number, source: OpenRing["source"]) => {
    const list = actionsRef.current.slice(0, RING_MAX_ACTIONS);
    if (list.length === 0) return false;
    engineRef.current?.destroy();
    keyRef.current += 1;
    setRing({
      key: keyRef.current,
      source,
      releaseButton: source === "context" ? heldButtonRef.current : null,
      x,
      y,
      title: latestTitleRef.current,
      actions: list,
      bands: bandsFor(list),
    });
    setDim("on");
    return true;
  }, []);

  /**
   * Opens a right-click's ring once the clicked pane's thread is the open
   * one: as soon as the thread changes and is ready, or after the grace
   * period when it stays the same.
   */
  const openPending = useCallback(() => {
    const pending = pendingOpenRef.current;
    if (!pending) return;
    const waited = performance.now() - pending.at;
    if (waited > PANE_SWITCH_LIMIT_MS) {
      pendingOpenRef.current = null;
      return;
    }
    if (!canOpenRef.current) return;
    if (threadKeyRef.current === pending.threadKey && waited < PANE_SWITCH_GRACE_MS) return;
    pendingOpenRef.current = null;
    openAt(pending.x, pending.y, "context");
  }, [openAt]);

  useEffect(() => {
    openPending();
  }, [canOpen, threadKey, openPending]);

  /** Removes the ring in the same frame, for typing and window blur. */
  const vanish = useCallback(() => {
    engineRef.current?.destroy();
    engineRef.current = null;
    for (const band of bandsRef.current) band.destroy();
    bandsRef.current = [];
    setRing(null);
    setDim((current) => (current === "off" ? current : "instant"));
  }, []);

  const closeRing = useCallback((kind: RingCloseKind) => {
    const engine = engineRef.current;
    if (!engine || engine.closing) return;
    // A run confirms its band option itself; any other close folds the band.
    if (kind !== "run") for (const band of bandsRef.current) band.retract();
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
    const chosen = bandsRef.current.findIndex((band) => band.sel >= 0);
    const band = chosen >= 0 ? bandsRef.current[chosen]! : null;
    const spec = chosen >= 0 ? open.bands[chosen]! : null;
    const option = band && spec ? spec.options[band.sel] : undefined;
    if (option && band && spec) {
      if (busyRef.current) {
        closeRing("cancel");
        return;
      }
      band.confirm();
      closeRing("run");
      onRunRef.current(open.actions[spec.parent]!.id, option.id);
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
      steer(engine, bandsRef.current, ring, Math.hypot(dx, dy), pointerAngle(dx, dy));
    };
    const release = (event: PointerEvent) => {
      // Press, drag, release: a right-click held through the ring runs what
      // it releases on. Released in the hub, the ring stays for a click.
      if (ring.releaseButton === null || event.button !== ring.releaseButton) return;
      const engine = engineRef.current;
      if (!engine || engine.closing) return;
      const dist = Math.hypot(event.clientX - ring.x, event.clientY - ring.y);
      if (dist > RING_DEAD_ZONE_PX) commit();
    };
    const press = (event: PointerEvent) => {
      // A right-click opens the ring and a second one in the hub closes it.
      if (
        ring.source === "context" &&
        isContextPress(event) &&
        Math.hypot(event.clientX - ring.x, event.clientY - ring.y) <= RING_DEAD_ZONE_PX
      ) {
        swallowMenuRef.current = true;
        closeRing("cancel");
        return;
      }
      // A press on the disc or the open band runs the selection on click.
      const target = event.target;
      if (
        target instanceof Node &&
        (baseRef.current?.contains(target) ||
          bandNodesRef.current.some((nodes) => nodes.svg?.contains(target)))
      ) {
        return;
      }
      closeRing("cancel");
    };
    window.addEventListener("pointermove", track, { passive: true });
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("pointerup", release);
    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("pointerup", release);
    };
  }, [closeRing, commit, ring]);

  useEffect(() => {
    if (!rightClick) {
      contextPressRef.current = null;
      pendingOpenRef.current = null;
      return;
    }
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        openPending();
      }, ms);
      timers.add(timer);
    };
    // Captured on window so the snapshot precedes BB's own press handlers,
    // which focus the pane, and the browser's word selection.
    const press = (event: PointerEvent) => {
      swallowMenuRef.current = false;
      if (!isContextPress(event)) {
        contextPressRef.current = null;
        return;
      }
      heldButtonRef.current = event.button;
      contextPressRef.current = {
        x: event.clientX,
        y: event.clientY,
        button: event.button,
        selection: snapshotSelection(),
        switchesPane: inUnfocusedPane(event.target),
        threadKey: threadKeyRef.current,
      };
    };
    const release = (event: PointerEvent) => {
      if (event.button === heldButtonRef.current) heldButtonRef.current = null;
    };
    // Bubble phase, so a menu BB or another plugin already showed for this
    // target (file links, the terminal) has called preventDefault first.
    const menu = (event: MouseEvent) => {
      const press = contextPressRef.current;
      contextPressRef.current = null;
      if (swallowMenuRef.current) {
        swallowMenuRef.current = false;
        event.preventDefault();
        return;
      }
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[data-bb-plugin="quick-actions"]')) {
        event.preventDefault();
        return;
      }
      const { clientX: x, clientY: y } = event;
      if (
        !press ||
        Math.hypot(x - press.x, y - press.y) > CONTEXT_PRESS_SLOP_PX ||
        keepsNativeMenu(target) ||
        selectionContains(press.selection, x, y) ||
        !isOverThreadPane(x, y)
      ) {
        return;
      }
      // A dialog owns the window while it is open.
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      if (!press.switchesPane && !canOpenRef.current) return;
      event.preventDefault();
      restoreSelection(press.selection);
      if (!press.switchesPane) {
        openAt(x, y, "context");
        return;
      }
      pendingOpenRef.current = { x, y, threadKey: press.threadKey, at: performance.now() };
      later(PANE_SWITCH_GRACE_MS);
      later(PANE_SWITCH_LIMIT_MS + 1);
    };
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("contextmenu", menu);
    return () => {
      for (const timer of timers) clearTimeout(timer);
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("contextmenu", menu);
    };
  }, [openAt, openPending, rightClick]);

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
        !event.shiftKey &&
        holdOptionRef.current &&
        // Option is just a modifier over a ring a right-click opened.
        !(isOpen() && ringRef.current?.source === "context")
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
          const { x, y } = pointer.current;
          if (!isOverThreadPane(x, y)) return;
          openAt(x, y, "hold");
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
      if (isOpen() && ringRef.current?.source === "hold") commit();
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
  }, [canOpen, closeRing, commit, openAt, pointer, vanish]);

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
            {/* Bands paint before the disc, so the disc and its shadow sit over
                the band where they meet. */}
            {ring.bands.map((spec, index) => (
              <svg
                key={spec.parent}
                ref={(node) => {
                  bandNodes(index).svg = node;
                }}
                className="qa-band"
                viewBox="-300 -300 600 600"
                aria-hidden="true"
              >
                <g className="qa-band-plate" onClick={commit}>
                  <path
                    ref={(node) => {
                      bandNodes(index).outline = node;
                    }}
                    className="qa-band-outline"
                  />
                  <path
                    ref={(node) => {
                      bandNodes(index).rim = node;
                    }}
                    className="qa-band-rim"
                  />
                  <path
                    ref={(node) => {
                      bandNodes(index).plate = node;
                    }}
                    className="qa-band-fill"
                  />
                </g>
                <g
                  ref={(node) => {
                    bandNodes(index).tileGroup = node;
                  }}
                >
                  <path
                    ref={(node) => {
                      bandNodes(index).tile = node;
                    }}
                    className="qa-ring-tile"
                  />
                </g>
              </svg>
            ))}
            <div ref={baseRef} className="qa-ring-base" onClick={commit} />
            <svg className="qa-ring-tiles" viewBox="-300 -300 600 600" aria-hidden="true">
              <g>
                <path ref={tileRef} className="qa-ring-tile" />
              </g>
            </svg>
            {ring.actions.map((action, index) => {
              const band = ring.bands.findIndex((spec) => spec.parent === index);
              return (
                <div
                  key={action.id}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  className="qa-ring-item"
                  role="menuitem"
                  aria-disabled={action.disabled ? "true" : undefined}
                  aria-haspopup={band >= 0 ? "menu" : undefined}
                  data-selected="false"
                >
                  <Icon name={action.icon} />
                  <span className="qa-ring-label">{action.label}</span>
                  {action.disabled ? (
                    <span className="qa-ring-note">Unavailable</span>
                  ) : null}
                  {band >= 0 ? (
                    // Points outward to the band of options this action opens.
                    <span
                      ref={(node) => {
                        bandNodes(band).more = node;
                      }}
                      className="qa-ring-more"
                      aria-hidden="true"
                    >
                      <Icon name="ChevronRight" />
                    </span>
                  ) : null}
                </div>
              );
            })}
            {ring.bands.map((spec, band) => (
              <div
                key={spec.parent}
                className="qa-band-items"
                role="menu"
                aria-label={ring.actions[spec.parent]!.label}
              >
                {spec.options.map((option, index) => (
                  <div
                    key={option.id}
                    ref={(node) => {
                      bandNodes(band).items[index] = node;
                    }}
                    className="qa-ring-item"
                    role="menuitem"
                    data-selected="false"
                  >
                    <span className="qa-ring-label">{option.label}</span>
                  </div>
                ))}
              </div>
            ))}
            {ring.title ? (
              // The ring fades this anchor with its labels; the band fades the
              // plate inside it while covering the top of the ring.
              <div ref={titleRef} className="qa-title-anchor">
                {ring.bands.reduceRight<ReactNode>(
                  // Each band fades its own layer, so whichever band covers
                  // the name hides it without the others writing over it.
                  (plate, _spec, band) => (
                    <div
                      ref={(node) => {
                        bandNodes(band).titleFade = node;
                      }}
                    >
                      {plate}
                    </div>
                  ),
                  <div ref={titlePlateRef} className="qa-ring-title">
                    {ring.title}
                  </div>,
                )}
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
