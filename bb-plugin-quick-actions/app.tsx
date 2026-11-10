import "./app.css";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  experimental_useThreadActions,
  useBbContext,
  useBbNavigate,
  useRpc,
  useSdk,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginThreadActionTarget,
  PluginThreadActionEntry,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { rpcContract } from "./server";
import {
  actionCssVariables,
  actionTarget,
  cursorActionCssVariables,
  hoverCorridorPoints,
  PIE_HUB_RADIUS_PX,
  PIE_RADIUS_PX,
  pieSliceAt,
  pieSlicePath,
  sanitizeCorner,
  sanitizeMotion,
  sanitizeTrigger,
  type Corner,
} from "./motion";

const CORE_ACTION_KEYS = [
  "bb--core/archive",
  "bb--core/pin",
  "bb--core/read",
  "bb--core/copyLink",
] as const;
const HOVER_CLOSE_DELAY_MS = 300;
const HOLD_OPTION_DELAY_MS = 200;
/** How long a run's chosen slice brightens before the pie closes. */
const PIE_CONFIRM_MS = 90;
/** Length of the pie's close motion, matching the CSS close transitions. */
const PIE_CLOSE_MS = 150;
/** Half of the 44px menu box, subtracted so the pie is centred on the pointer. */
const MENU_BOX_OFFSET_PX = 22;
/** Keys that leave the open pie alone: modifiers pressed alongside Option. */
const PASSIVE_KEYS = new Set(["Shift", "Meta", "Control", "CapsLock", "Alt"]);

function Hint({
  label,
  side,
  children,
}: {
  label: string;
  side: "top" | "bottom";
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

function useMenuPosition(
  corner: Corner,
  threadId: string,
  enabled: boolean,
): CSSProperties {
  const [position, setPosition] = useState({
    x: 16,
    y: corner.startsWith("top") ? 112 : window.innerHeight - 60,
  });

  useLayoutEffect(() => {
    if (!enabled) return;
    let active = true;
    let footer: HTMLElement | null = null;
    let threadWindow: HTMLElement | null = null;
    let frame: number | null = null;
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => scheduleUpdate())
        : null;
    const anchorMutations =
      typeof MutationObserver === "function"
        ? new MutationObserver(() => scheduleUpdate())
        : null;
    const discoveryMutations =
      typeof MutationObserver === "function"
        ? new MutationObserver(() => scheduleUpdate())
        : null;
    const update = () => {
      frame = null;
      if (!active) return;
      const nextFooter =
        document.querySelector<HTMLElement>("[data-scroll-footer]");
      if (!nextFooter) {
        discoveryMutations?.disconnect();
        const nextWindow =
          document.querySelector<HTMLElement>("[data-thread-window]");
        if (nextWindow) {
          discoveryMutations?.observe(nextWindow, {
            childList: true,
            subtree: true,
          });
        }
        return;
      }
      discoveryMutations?.disconnect();
      const nextThreadWindow =
        nextFooter.closest<HTMLElement>("[data-thread-window]");
      if (nextFooter !== footer || nextThreadWindow !== threadWindow) {
        observer?.disconnect();
        anchorMutations?.disconnect();
        footer = nextFooter;
        threadWindow = nextThreadWindow;
        if (footer) observer?.observe(footer);
        if (threadWindow) observer?.observe(threadWindow);
        if (footer?.parentElement) {
          anchorMutations?.observe(footer.parentElement, { childList: true });
        }
      }
      const footerRect = footer?.getBoundingClientRect();
      const windowRect = threadWindow?.getBoundingClientRect();
      const leftEdge = footerRect?.left ?? 0;
      const rightEdge = footerRect?.right ?? window.innerWidth;
      const topEdge = (windowRect?.top ?? 48) + 64;
      const bottomCornerTop =
        (footerRect?.top ?? windowRect?.bottom ?? window.innerHeight) - 60;
      const next = {
        x: corner.endsWith("right") ? rightEdge - 60 : leftEdge + 16,
        y: corner.startsWith("top") ? topEdge : bottomCornerTop,
      };
      setPosition((current) =>
        current.x === next.x && current.y === next.y ? current : next,
      );
    };
    const scheduleUpdate = () => {
      if (active && frame === null) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      active = false;
      if (frame !== null) cancelAnimationFrame(frame);
      discoveryMutations?.disconnect();
      anchorMutations?.disconnect();
      observer?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [corner, threadId, enabled]);

  return {
    "--qa-menu-x": `${position.x}px`,
    "--qa-menu-y": `${position.y}px`,
  } as CSSProperties;
}

type QuickActionItem = {
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
};

/**
 * Tracks the pointer so the hold-Option fan can open where the user's hand
 * already is. Clicks update it too: a click without a preceding move (a trackpad
 * tap, for instance) must still count as the pointer's location.
 */
function usePointerPosition() {
  const point = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const track = (event: { clientX: number; clientY: number }) => {
      point.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", track, { passive: true });
    window.addEventListener("pointerdown", track, { passive: true, capture: true });
    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerdown", track, { capture: true });
    };
  }, []);
  return point;
}

function coreItem(
  entries: readonly PluginThreadActionEntry[],
  key: string,
): QuickActionItem | null {
  const entry = entries.find((candidate) => candidate.key === key);
  if (!entry) return null;
  return {
    id: key,
    label: entry.action.label,
    icon: entry.action.icon,
    disabled: entry.action.disabled,
    run: () => entry.action.run(),
  };
}

const QuickActionsMenu = memo(function QuickActionsMenu({
  thread,
  targetThreadId,
  threadReady,
}: {
  thread: PluginThreadActionTarget;
  targetThreadId: string;
  threadReady: boolean;
}) {
  const settings = useSettings();
  const corner = sanitizeCorner(settings.values?.corner);
  const motion = sanitizeMotion(settings.values?.motion);
  const trigger = sanitizeTrigger(settings.values?.trigger);
  const holdOption = trigger === "hold-option";
  const debugRegions = settings.values?.debugRegions === true;
  const position = useMenuPosition(corner, targetThreadId, !holdOption);
  const pointer = usePointerPosition();
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { threadId: routeThreadId } = useBbContext();
  const routeThreadIdRef = useRef(routeThreadId);
  routeThreadIdRef.current = routeThreadId;
  const targetThreadIdRef = useRef(targetThreadId);
  targetThreadIdRef.current = targetThreadId;
  const restoringFocusRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [snoozeDialog, setSnoozeDialog] = useState<{
    open: boolean;
    childCount: number;
    thread: PluginThreadActionTarget | null;
  }>({
    open: false,
    childCount: 0,
    thread: null,
  });
  const [pinned, setPinned] = useState(false);
  const [requestedOpen, setRequestedOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [instantClose, setInstantClose] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entries = experimental_useThreadActions(thread, {
    keys: CORE_ACTION_KEYS,
  });
  const tooltipSide = corner.startsWith("top") ? "bottom" : "top";

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  useEffect(() => cancelScheduledClose, [cancelScheduledClose]);

  const requestedOpenRef = useRef(requestedOpen);
  requestedOpenRef.current = requestedOpen;


  const open = useCallback(() => {
    if (!threadReady || settings.isLoading) return;
    cancelScheduledClose();
    setRequestedOpen(true);
  }, [cancelScheduledClose, settings.isLoading, threadReady]);
  const close = useCallback(() => {
    if (pinned) return;
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setRequestedOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelScheduledClose, pinned]);
  const closeAndFocus = useCallback(() => {
    cancelScheduledClose();
    setPinned(false);
    triggerRef.current?.focus({ preventScroll: true });
    setRequestedOpen(false);
  }, [cancelScheduledClose]);

  useEffect(() => {
    const menu = triggerRef.current?.closest(".qa-menu");
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused !== triggerRef.current &&
      menu?.contains(focused)
    ) {
      restoringFocusRef.current = true;
      triggerRef.current?.focus({ preventScroll: true });
      restoringFocusRef.current = false;
    }
    cancelScheduledClose();
    setPinned(false);
    setRequestedOpen(false);
    setSnoozeDialog({ open: false, childCount: 0, thread: null });
  }, [cancelScheduledClose, targetThreadId]);

  const executeSnooze = async (target: PluginThreadActionTarget) => {
    const result = await rpc.call("snooze", { threadId: target.id });
    toast.success(
      `Snoozed until ${new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      }).format(result.wakeAt)}`,
    );
    if (mountedRef.current && routeThreadIdRef.current === target.id) {
      navigate.toCompose({ projectId: target.projectId });
    }
  };

  const actions: QuickActionItem[] = [
    coreItem(entries, "bb--core/archive"),
    thread.archivedAt === null
      ? {
          id: "snooze",
          label: "Snooze",
          icon: "Clock",
          run: async () => {
            const summary = await sdk.threads.childSummary({
              threadId: thread.id,
            });
            if (targetThreadIdRef.current !== thread.id) return;
            if (summary.unarchivedDescendantCount > 0) {
              setSnoozeDialog({
                open: true,
                childCount: summary.unarchivedDescendantCount,
                thread,
              });
              return;
            }
            await executeSnooze(thread);
          },
        }
      : null,
    coreItem(entries, "bb--core/pin"),
    coreItem(entries, "bb--core/read"),
    coreItem(entries, "bb--core/copyLink"),
  ].filter((item): item is QuickActionItem => item !== null);

  const canOpen = threadReady && !settings.isLoading && actions.length > 0;
  const actionCount = actions.length;

  // The pie selects by direction: whichever slice the pointer points into from
  // the centre is selected, wherever along that ray the pointer sits. Inside
  // the hub nothing is.
  const [selected, setSelected] = useState<number | null>(null);
  const [pressed, setPressed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [closeKind, setCloseKind] = useState<"cancel" | "run">("cancel");
  const [chosen, setChosen] = useState<number | null>(null);
  const pieRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const confirmingRef = useRef(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Until this time a close is still animating, so a reopen keeps its centre. */
  const closingUntilRef = useRef(0);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    if (!holdOption || !requestedOpen) {
      setSelected(null);
      setPressed(false);
      return;
    }
    const track = (event: PointerEvent) => {
      if (confirmingRef.current) return;
      setSelected(
        pieSliceAt(
          { x: event.clientX - origin.x, y: event.clientY - origin.y },
          actionCount,
        ),
      );
    };
    window.addEventListener("pointermove", track, { passive: true });
    return () => window.removeEventListener("pointermove", track);
  }, [actionCount, holdOption, origin, requestedOpen]);

  const clearConfirm = useCallback(() => {
    if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = null;
    confirmingRef.current = false;
    setConfirming(false);
  }, []);
  useEffect(() => clearConfirm, [clearConfirm]);

  const runPieItem = useCallback(async (item: QuickActionItem) => {
    setPending(item.id);
    try {
      await item.run();
    } catch (cause) {
      toast.error(
        `${item.label} failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    } finally {
      setPending(null);
    }
  }, []);

  /** Closes with the cancel motion: the lit slice drops, items retract. */
  const cancelPie = useCallback(() => {
    clearConfirm();
    setCloseKind("cancel");
    setChosen(null);
    setInstantClose(false);
    if (requestedOpenRef.current) {
      closingUntilRef.current = performance.now() + PIE_CLOSE_MS;
    }
    setRequestedOpen(false);
  }, [clearConfirm]);

  /** Removes the pie in the same frame, for typing and window blur. */
  const dismissPie = useCallback(() => {
    clearConfirm();
    setChosen(null);
    setInstantClose(true);
    setRequestedOpen(false);
  }, [clearConfirm]);

  /**
   * Runs a slice: it brightens and its item grows for a beat, then the pie
   * closes around the chosen item and the action runs. A disabled slice, or
   * nothing selected, closes without running.
   */
  const commitPie = useCallback(
    (index: number | null) => {
      if (confirmingRef.current) return;
      const item = index === null ? undefined : actionsRef.current[index];
      if (!item || item.disabled || pendingRef.current !== null) {
        cancelPie();
        return;
      }
      confirmingRef.current = true;
      setConfirming(true);
      setSelected(index);
      const reduced = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      confirmTimerRef.current = setTimeout(
        () => {
          confirmTimerRef.current = null;
          confirmingRef.current = false;
          setConfirming(false);
          setChosen(index);
          setCloseKind("run");
          setInstantClose(false);
          closingUntilRef.current = performance.now() + PIE_CLOSE_MS;
          setRequestedOpen(false);
          void runPieItem(item);
        },
        reduced ? 0 : PIE_CONFIRM_MS,
      );
    },
    [cancelPie, runPieItem],
  );

  // A press on the disc shows on the lit slice; a press anywhere else cancels.
  useEffect(() => {
    if (!holdOption || !requestedOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const pie = pieRef.current;
      if (pie && event.target instanceof Node && pie.contains(event.target)) {
        setPressed(true);
        return;
      }
      if (
        containerRef.current &&
        event.target instanceof Node &&
        containerRef.current.contains(event.target)
      ) {
        return;
      }
      cancelPie();
    };
    const onPointerUp = () => setPressed(false);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
    };
  }, [cancelPie, holdOption, requestedOpen]);

  // Hold Option anywhere and the pie opens centred on the pointer. A 200ms hold
  // keeps Option-letter accents (⌥e) intact. Releasing Option runs the
  // selected slice, or cancels from the hub; any other keypress drops the pie
  // so typing is never interrupted by it.
  useEffect(() => {
    if (!holdOption) return;
    if (!canOpen) {
      setRequestedOpen(false);
      return;
    }
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let held = false;
    const clearHold = () => {
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = null;
    };
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
          if (!held || confirmingRef.current) return;
          // The centre is wherever the pointer is when the hold completes,
          // unless a close is still animating, which reopens in place.
          if (performance.now() >= closingUntilRef.current) {
            setOrigin({ ...pointer.current });
          }
          setChosen(null);
          setCloseKind("cancel");
          setInstantClose(false);
          setRequestedOpen(true);
        }, HOLD_OPTION_DELAY_MS);
        return;
      }
      if (!held && !requestedOpenRef.current && !confirmingRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        held = false;
        clearHold();
        cancelPie();
        return;
      }
      // Chords with Option held are common; modifiers alone never dismiss.
      if (PASSIVE_KEYS.has(event.key)) return;
      held = false;
      clearHold();
      // Typing: get out of the way without a retract animation over the composer.
      dismissPie();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Alt") return;
      held = false;
      clearHold();
      if (!requestedOpenRef.current || confirmingRef.current) return;
      commitPie(selectedRef.current);
    };
    const onBlur = () => {
      held = false;
      clearHold();
      dismissPie();
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
  }, [canOpen, cancelPie, commitPie, dismissPie, holdOption, pointer]);

  const activate = async (item: QuickActionItem) => {
    if (pending || !canOpen) return;
    setPending(item.id);
    closeAndFocus();
    try {
      await item.run();
    } catch (cause) {
      toast.error(
        `${item.label} failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    } finally {
      setPending(null);
    }
  };

  const confirmSnooze = async () => {
    if (pending || !snoozeDialog.thread) return;
    const target = snoozeDialog.thread;
    setPending("snooze");
    setSnoozeDialog((current) => ({ ...current, open: false }));
    try {
      await executeSnooze(target);
    } catch (cause) {
      toast.error(
        `Snooze failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setPending(null);
    }
  };

  const menuStyle: CSSProperties = holdOption
    ? ({
        "--qa-menu-x": `${origin.x - MENU_BOX_OFFSET_PX}px`,
        "--qa-menu-y": `${origin.y - MENU_BOX_OFFSET_PX}px`,
        "--qa-pie-radius": `${PIE_RADIUS_PX}px`,
      } as CSSProperties)
    : position;

  return (
    <>
      <TooltipProvider delayDuration={250} skipDelayDuration={100}>
        <div
          ref={containerRef}
          className="qa-menu"
          data-bb-plugin-root=""
          data-bb-plugin="quick-actions"
          data-trigger={trigger}
          data-corner={corner}
          data-motion={motion}
          data-debug={debugRegions ? "true" : "false"}
          data-open={requestedOpen ? "true" : "false"}
          data-can-open={canOpen ? "true" : "false"}
          data-instant={instantClose ? "true" : "false"}
          data-close={closeKind}
          data-confirming={confirming ? "true" : "false"}
          data-pressed={pressed ? "true" : "false"}
          data-in-hub={holdOption && selected === null ? "true" : "false"}
          style={menuStyle}
          role="group"
          aria-label="Quick actions"
          aria-busy={!threadReady || settings.isLoading || pending !== null}
          onPointerEnter={
            holdOption
              ? undefined
              : () => {
                  if (canOpen) open();
                }
          }
          onPointerLeave={
            holdOption
              ? undefined
              : (event) => {
                  if (!event.currentTarget.contains(document.activeElement)) {
                    close();
                  }
                }
          }
          onBlur={(event) => {
            if (holdOption) return;
            if (!event.currentTarget.contains(event.relatedTarget)) close();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            if (holdOption) {
              cancelPie();
              return;
            }
            closeAndFocus();
          }}
        >
          {holdOption ? null : (
            <>
              <div className="qa-hover-core" aria-hidden="true" />
              <svg
                className="qa-hover-regions"
                viewBox="-140 -140 280 280"
                aria-hidden="true"
                focusable="false"
              >
                {actions.map((item, index) => {
                  const points = hoverCorridorPoints(
                    actionTarget(index, actions.length, corner),
                  );
                  return (
                    <path
                      key={item.id}
                      className="qa-hover-corridor"
                      d={`M ${points} Z`}
                    />
                  );
                })}
              </svg>
            </>
          )}
          {holdOption ? null : (
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            size="icon"
            className="qa-trigger"
            aria-label={
              requestedOpen ? "Close quick actions" : "Open quick actions"
            }
            aria-expanded={requestedOpen}
            aria-controls="qa-actions"
            aria-disabled={!canOpen}
            onFocus={() => {
              if (!restoringFocusRef.current && canOpen) open();
            }}
            onClick={() => {
              if (!canOpen) return;
              if (requestedOpen && pinned) {
                setPinned(false);
                setRequestedOpen(false);
              } else {
                setPinned(true);
                open();
              }
            }}
          >
            <Icon name="Plus" />
          </Button>
          )}
          {holdOption ? (
            <div
              ref={pieRef}
              className="qa-pie"
              aria-hidden="true"
              onClick={() => commitPie(selectedRef.current)}
            >
              <svg
                className="qa-pie-slices"
                viewBox={`${-PIE_RADIUS_PX} ${-PIE_RADIUS_PX} ${PIE_RADIUS_PX * 2} ${PIE_RADIUS_PX * 2}`}
                focusable="false"
              >
                {actions.map((item, index) => (
                  <path
                    key={item.id}
                    className="qa-pie-slice"
                    data-lit={
                      selected === index && !item.disabled ? "true" : "false"
                    }
                    data-chosen={chosen === index ? "true" : "false"}
                    d={pieSlicePath(actionCount)}
                    style={{
                      transform: `rotate(${(index * 360) / actionCount}deg)`,
                    }}
                  />
                ))}
                <circle className="qa-pie-hub" r={PIE_HUB_RADIUS_PX} />
                <circle
                  className="qa-pie-hub-ring"
                  r={PIE_HUB_RADIUS_PX - 0.5}
                />
              </svg>
            </div>
          ) : null}
          <div
            id="qa-actions"
            className="qa-actions"
            inert={!requestedOpen || !canOpen}
          >
            {actions.map((item, index) => {
              const style = holdOption
                ? cursorActionCssVariables({
                    index,
                    count: actions.length,
                  })
                : actionCssVariables({
                    index,
                    count: actions.length,
                    corner,
                  });
              if (holdOption) {
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="qa-action"
                    style={style}
                    data-selected={selected === index ? "true" : "false"}
                    data-chosen={chosen === index ? "true" : "false"}
                    disabled={item.disabled || pending !== null}
                    tabIndex={-1}
                    onClick={() => commitPie(index)}
                  >
                    <Icon name={item.icon} />
                    <span className="qa-action-label">{item.label}</span>
                  </button>
                );
              }
              return (
                <Hint key={item.id} label={item.label} side={tooltipSide}>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="qa-action"
                    style={style}
                    aria-label={item.label}
                    disabled={item.disabled || pending !== null}
                    tabIndex={requestedOpen && canOpen ? 0 : -1}
                    onClick={() => void activate(item)}
                  >
                    <Icon name={item.icon} />
                  </Button>
                </Hint>
              );
            })}
          </div>
        </div>
      </TooltipProvider>
      <AlertDialog
        open={snoozeDialog.open}
        onOpenChange={(open) =>
          setSnoozeDialog((current) => ({ ...current, open }))
        }
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (mountedRef.current) closeAndFocus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Snooze {snoozeDialog.childCount + 1} threads?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This archives the current thread and {snoozeDialog.childCount}{" "}
              active{" "}
              {snoozeDialog.childCount === 1 ? "child thread" : "child threads"}{" "}
              until 9:00 AM tomorrow. They wake together.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending !== null}
              onClick={() => void confirmSnooze()}
            >
              Snooze {snoozeDialog.childCount + 1} threads
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
});

function ThreadQuickActions({ threadId }: { threadId: string }) {
  const sdk = useSdk();
  const sidebar = experimental_useSidebarThreads();
  const [fetched, setFetched] = useState<PluginThreadActionTarget | null>(null);
  const previousThreadRef = useRef<PluginThreadActionTarget | null>(null);
  const listed = sidebar.threads.find((thread) => thread.id === threadId);
  const listedPresent = listed !== undefined;
  useEffect(() => {
    let active = true;
    setFetched(null);
    sdk.threads
      .get({ threadId, include: "environment" })
      .then((result) => {
        if (!active) return;
        setFetched({
          id: result.id,
          projectId: result.projectId,
          parentThreadId: result.parentThreadId,
          parentNotifications: result.parentNotifications,
          archivedAt: result.archivedAt,
          pinnedAt: result.pinnedAt,
          sectionId: result.sectionId,
          isUnread: (result.lastReadAt ?? 0) < result.latestAttentionAt,
          status: result.status,
          environment:
            "environment" in result && result.environment !== undefined
              ? result.environment === null
                ? null
                : { id: result.environment.id, path: result.environment.path }
              : result.environmentId === null
                ? null
                : { id: result.environmentId, path: null },
        });
      })
      .catch(() => {
        if (active) setFetched(null);
      });
    return () => {
      active = false;
    };
  }, [
    sdk,
    threadId,
    listedPresent,
    listed?.archivedAt,
    listed?.isUnread,
    listed?.pinnedAt,
  ]);
  const currentThread = useMemo<PluginThreadActionTarget | null>(
    () =>
      listed
        ? {
            id: listed.id,
            projectId: listed.projectId,
            parentThreadId: listed.parentThreadId,
            parentNotifications: listed.parentNotifications,
            archivedAt: listed.archivedAt,
            pinnedAt: listed.pinnedAt,
            sectionId: listed.sectionId,
            isUnread: listed.isUnread,
            status: listed.status,
            environment: listed.environment?.id
              ? { id: listed.environment.id, path: listed.environment.path }
              : null,
          }
        : fetched?.id === threadId
          ? fetched
          : null,
    [fetched, listed, threadId],
  );
  if (currentThread) previousThreadRef.current = currentThread;
  const displayThread = currentThread ?? previousThreadRef.current;
  return displayThread ? (
    <QuickActionsMenu
      thread={displayThread}
      targetThreadId={threadId}
      threadReady={currentThread !== null}
    />
  ) : null;
}

export function QuickActionsOverlay({
  threadId: providedThreadId,
}: { threadId?: string } = {}) {
  const context = useBbContext();
  const threadId = providedThreadId ?? context.threadId;
  return threadId ? <ThreadQuickActions threadId={threadId} /> : null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "quick-actions",
    component: QuickActionsOverlay,
  });
});
