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

function useMenuPosition(corner: Corner): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>(() => ({
    left: 16,
    top: corner.startsWith("top") ? 64 : window.innerHeight - 60,
  }));

  useLayoutEffect(() => {
    const footer = document.querySelector<HTMLElement>("[data-scroll-footer]");
    const threadWindow = footer?.closest<HTMLElement>("[data-thread-window]");
    const update = () => {
      const footerRect = footer?.getBoundingClientRect();
      const windowRect = threadWindow?.getBoundingClientRect();
      const leftEdge = footerRect?.left ?? 0;
      const rightEdge = footerRect?.right ?? window.innerWidth;
      const topEdge = (windowRect?.top ?? 0) + 64;
      const bottomCornerTop =
        (footerRect?.top ?? windowRect?.bottom ?? window.innerHeight) - 60;
      setPosition({
        left: corner.endsWith("right") ? rightEdge - 60 : leftEdge + 16,
        top: corner.startsWith("top") ? topEdge : bottomCornerTop,
      });
    };
    update();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    if (footer) observer?.observe(footer);
    if (threadWindow) observer?.observe(threadWindow);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [corner]);

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

function QuickActionsMenu({ thread }: { thread: PluginThreadActionTarget }) {
  const settings = useSettings();
  const corner = sanitizeCorner(settings.values?.corner);
  const motion = sanitizeMotion(settings.values?.motion);
  const debugRegions = settings.values?.debugRegions === true;
  const reducedMotion = useReducedMotion();
  const { time, play } = useAnimationClock();
  const position = useMenuPosition(corner);
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { threadId: routeThreadId } = useBbContext();
  const routeThreadIdRef = useRef(routeThreadId);
  routeThreadIdRef.current = routeThreadId;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [snoozeDialog, setSnoozeDialog] = useState({
    open: false,
    childCount: 0,
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
    cancelScheduledClose();
    setRequestedOpen(true);
    play(1);
  }, [cancelScheduledClose, play]);
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

  const executeSnooze = async () => {
    const result = await rpc.call("snooze", { threadId: thread.id });
    toast.success(
      `Snoozed until ${new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      }).format(result.wakeAt)}`,
    );
    if (mountedRef.current && routeThreadIdRef.current === thread.id) {
      navigate.toCompose({ projectId: thread.projectId });
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
            if (summary.unarchivedDescendantCount > 0) {
              setSnoozeDialog({
                open: true,
                childCount: summary.unarchivedDescendantCount,
              });
              return;
            }
            await executeSnooze();
          },
        }
      : null,
    coreItem(entries, "bb--core/pin"),
    coreItem(entries, "bb--core/read"),
    coreItem(entries, "bb--core/copyLink"),
  ].filter((item): item is QuickActionItem => item !== null);

  if (settings.isLoading || actions.length === 0) return null;

  const activate = async (item: QuickActionItem) => {
    if (pending) return;
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
    if (pending) return;
    setPending("snooze");
    setSnoozeDialog((current) => ({ ...current, open: false }));
    try {
      await executeSnooze();
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
          style={position}
          role="group"
          aria-label="Quick actions"
          aria-busy={pending !== null}
          onPointerEnter={open}
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
            onFocus={open}
            onClick={() => {
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
          <div id="qa-actions" className="qa-actions" inert={!requestedOpen}>
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
                    tabIndex={requestedOpen ? 0 : -1}
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
  const thread: PluginThreadActionTarget | null = listed
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
    : fetched;
  return thread ? <QuickActionsMenu thread={thread} /> : null;
}

function QuickActionsOverlay() {
  const { threadId } = useBbContext();
  return threadId ? (
    <ThreadQuickActions key={threadId} threadId={threadId} />
  ) : null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "quick-actions",
    component: QuickActionsOverlay,
  });
});
