import "./app.css";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  actionFrame,
  actionTarget,
  hoverCorridorPoints,
  MENU_DURATION_MS,
  sanitizeCorner,
  sanitizeMotion,
  triggerRotation,
  type Corner,
} from "./motion";

const CORE_ACTION_KEYS = [
  "bb--core/archive",
  "bb--core/pin",
  "bb--core/read",
  "bb--core/copyLink",
] as const;
const HOVER_CLOSE_DELAY_MS = 300;

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

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function useAnimationClock() {
  const [time, setTime] = useState(0);
  const timeRef = useRef(0);
  const directionRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const previousRef = useRef<number | null>(null);

  const tick = useCallback(function step(now: number) {
    if (directionRef.current === 0) {
      frameRef.current = null;
      return;
    }
    if (previousRef.current !== null) {
      const elapsed = now - previousRef.current;
      timeRef.current = Math.max(
        0,
        Math.min(
          MENU_DURATION_MS,
          timeRef.current + elapsed * directionRef.current,
        ),
      );
      setTime(timeRef.current);
    }
    previousRef.current = now;
    if (
      (directionRef.current > 0 && timeRef.current >= MENU_DURATION_MS) ||
      (directionRef.current < 0 && timeRef.current <= 0)
    ) {
      directionRef.current = 0;
      previousRef.current = null;
      frameRef.current = null;
      return;
    }
    frameRef.current = requestAnimationFrame(step);
  }, []);

  const play = useCallback(
    (direction: 1 | -1) => {
      directionRef.current = direction;
      previousRef.current = null;
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(tick);
      }
    },
    [tick],
  );

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return { time, play };
}

function useMenuPosition(corner: Corner, threadId: string): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>(() => ({
    left: 16,
    top: corner.startsWith("top") ? 112 : window.innerHeight - 60,
  }));

  useLayoutEffect(() => {
    let footer: HTMLElement | null = null;
    let threadWindow: HTMLElement | null = null;
    let frame: number | null = null;
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => scheduleUpdate())
        : null;
    const update = () => {
      frame = null;
      const nextFooter =
        document.querySelector<HTMLElement>("[data-scroll-footer]");
      const nextThreadWindow =
        nextFooter?.closest<HTMLElement>("[data-thread-window]") ?? null;
      if (nextFooter !== footer || nextThreadWindow !== threadWindow) {
        observer?.disconnect();
        footer = nextFooter;
        threadWindow = nextThreadWindow;
        if (footer) observer?.observe(footer);
        if (threadWindow) observer?.observe(threadWindow);
      }
      const footerRect = footer?.getBoundingClientRect();
      const windowRect = threadWindow?.getBoundingClientRect();
      const leftEdge = footerRect?.left ?? 0;
      const rightEdge = footerRect?.right ?? window.innerWidth;
      const topEdge = (windowRect?.top ?? 48) + 64;
      const bottomCornerTop =
        (footerRect?.top ?? windowRect?.bottom ?? window.innerHeight) - 60;
      const next = {
        left: corner.endsWith("right") ? rightEdge - 60 : leftEdge + 16,
        top: corner.startsWith("top") ? topEdge : bottomCornerTop,
      };
      setPosition((current) =>
        current.left === next.left && current.top === next.top ? current : next,
      );
    };
    const scheduleUpdate = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    update();
    const mutations =
      typeof MutationObserver === "function"
        ? new MutationObserver(() => {
            const nextFooter =
              document.querySelector<HTMLElement>("[data-scroll-footer]");
            const nextThreadWindow =
              nextFooter?.closest<HTMLElement>("[data-thread-window]") ?? null;
            if (nextFooter !== footer || nextThreadWindow !== threadWindow) {
              scheduleUpdate();
            }
          })
        : null;
    mutations?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      mutations?.disconnect();
      observer?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [corner, threadId]);

  return position;
}

type QuickActionItem = {
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
};

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

function QuickActionsMenu({
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
  const debugRegions = settings.values?.debugRegions === true;
  const reducedMotion = useReducedMotion();
  const { time, play } = useAnimationClock();
  const position = useMenuPosition(corner, targetThreadId);
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
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entries = experimental_useThreadActions(thread, {
    keys: CORE_ACTION_KEYS,
  });
  const isOpen = time > 0;
  const tooltipSide = corner.startsWith("top") ? "bottom" : "top";
  useEffect(() => {
    if (!requestedOpen) setActiveAction(null);
  }, [requestedOpen]);

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  useEffect(() => cancelScheduledClose, [cancelScheduledClose]);

  const open = useCallback(() => {
    if (!threadReady || settings.isLoading) return;
    cancelScheduledClose();
    setRequestedOpen(true);
    play(1);
  }, [cancelScheduledClose, play, settings.isLoading, threadReady]);
  const close = useCallback(() => {
    if (pinned) return;
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setRequestedOpen(false);
      play(-1);
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelScheduledClose, pinned, play]);
  const closeAndFocus = useCallback(() => {
    cancelScheduledClose();
    setPinned(false);
    triggerRef.current?.focus({ preventScroll: true });
    setRequestedOpen(false);
    play(-1);
  }, [cancelScheduledClose, play]);

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
    play(-1);
  }, [cancelScheduledClose, play, targetThreadId]);

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

  return (
    <>
      <TooltipProvider delayDuration={250} skipDelayDuration={100}>
        <div
          className="qa-menu"
          data-bb-plugin-root=""
          data-bb-plugin="quick-actions"
          data-corner={corner}
          data-motion={motion}
          data-debug={debugRegions ? "true" : "false"}
          data-open={isOpen ? "true" : "false"}
          data-can-open={canOpen ? "true" : "false"}
          style={position}
          role="group"
          aria-label="Quick actions"
          aria-busy={!threadReady || settings.isLoading || pending !== null}
          onPointerEnter={() => {
            if (canOpen) open();
          }}
          onPointerLeave={(event) => {
            if (!event.currentTarget.contains(document.activeElement)) close();
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) close();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeAndFocus();
            }
          }}
        >
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
              if (isOpen && pinned) {
                setPinned(false);
                setRequestedOpen(false);
                play(-1);
              } else {
                setPinned(true);
                open();
              }
            }}
          >
            <Icon
              name="Plus"
              style={{
                transform: `rotate(${triggerRotation(time, reducedMotion)}deg)`,
              }}
            />
          </Button>
          <div
            id="qa-actions"
            className="qa-actions"
            inert={!requestedOpen || !canOpen}
          >
            {actions.map((item, index) => {
              const frame = actionFrame({
                motion,
                index,
                count: actions.length,
                corner,
                time,
                reducedMotion,
              });
              return (
                <Hint key={item.id} label={item.label} side={tooltipSide}>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="qa-action"
                    style={frame}
                    data-active={activeAction === item.id ? "true" : "false"}
                    aria-label={item.label}
                    disabled={item.disabled || pending !== null}
                    tabIndex={requestedOpen && canOpen ? 0 : -1}
                    onPointerEnter={() => setActiveAction(item.id)}
                    onPointerLeave={() =>
                      setActiveAction((current) =>
                        current === item.id ? null : current,
                      )
                    }
                    onFocus={() => setActiveAction(item.id)}
                    onBlur={() =>
                      setActiveAction((current) =>
                        current === item.id ? null : current,
                      )
                    }
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
}

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
  const currentThread: PluginThreadActionTarget | null = listed
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
      : null;
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
