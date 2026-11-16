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
  experimental_useThreadActionRegistrations,
  experimental_useThreadActions,
  useBbContext,
  useSdk,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginThreadActionTarget,
  PluginThreadActionEntry,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PointerPie, type PieOption } from "./pointer-pie";
import { ActionsSettings } from "./actions-settings";
import { useRingActions } from "./use-ring-actions";
import {
  actionCssVariables,
  actionTarget,
  hoverCorridorPoints,
  sanitizeCorner,
  sanitizeMotion,
  sanitizeRightClick,
  sanitizeTrigger,
  type Corner,
} from "./motion";

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
  /** Choices for the hold ring's outer band; see `PieAction.options`. */
  options?: () => readonly PieOption[];
  /** Runs the action, with the band option chosen for it, if any. */
  run: (optionId?: string) => void | Promise<void>;
};

/**
 * A BB thread action as a ring action. Its enabled choices, if any, fill the
 * band. BB documents an action's `detail` as the current value of its choice
 * list, so the choice with that label is the default: the band lights it
 * while the pointer is on the action, and a run without a choice, from the
 * corner menu or before the band opens, takes it. With no such choice, that
 * run passes no value and the action decides.
 */
function threadActionItem(entry: PluginThreadActionEntry): QuickActionItem {
  const { action } = entry;
  const choices = (action.choices?.items ?? []).filter((choice) => !choice.disabled);
  const defaultChoice = choices.find((choice) => choice.label === action.detail);
  return {
    id: entry.key,
    label: action.label,
    icon: action.icon,
    disabled: action.disabled,
    options:
      choices.length > 0
        ? () =>
            choices.map((choice) => ({
              id: choice.id,
              label: choice.label,
              isDefault: choice === defaultChoice,
            }))
        : undefined,
    run: (optionId) => action.run(optionId ?? defaultChoice?.id),
  };
}

/**
 * A ring action BB has nothing for on this thread: the thread lacks it, or
 * its plugin is gone. It keeps its slot, so every other action points the
 * same way on every thread, and running it reports that it's unavailable.
 */
function unavailableItem(key: string, title: string, icon: string): QuickActionItem {
  return { id: key, label: title, icon, disabled: true, run: () => undefined };
}

const QuickActionsMenu = memo(function QuickActionsMenu({
  thread,
  threadTitle,
  targetThreadId,
  threadReady,
}: {
  thread: PluginThreadActionTarget;
  /** What the ring names as the thread its actions apply to. */
  threadTitle: string | null;
  targetThreadId: string;
  threadReady: boolean;
}) {
  const settings = useSettings();
  const corner = sanitizeCorner(settings.values?.corner);
  const motion = sanitizeMotion(settings.values?.motion);
  const trigger = sanitizeTrigger(settings.values?.trigger);
  const holdOption = trigger === "hold-option";
  const rightClick = sanitizeRightClick(settings.values?.rightClick);
  const debugRegions = settings.values?.debugRegions === true;
  const position = useMenuPosition(corner, targetThreadId, !holdOption);
  const restoringFocusRef = useRef(false);
  const [pinned, setPinned] = useState(false);
  const [requestedOpen, setRequestedOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringActions = useRingActions();
  const keys = useMemo(
    () => ringActions.actions.map((action) => action.key),
    [ringActions.actions],
  );
  const entries = experimental_useThreadActions(thread, { keys });
  const registrations = experimental_useThreadActionRegistrations();
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
  }, [cancelScheduledClose, targetThreadId]);

  const actions = ringActions.actions.map((action) => {
    const entry = entries.find((candidate) => candidate.key === action.key);
    if (entry) return threadActionItem(entry);
    const registration = registrations.find((candidate) => candidate.key === action.key);
    return unavailableItem(
      action.key,
      registration?.title ?? action.title,
      registration?.icon ?? action.icon,
    );
  });

  const canOpen =
    threadReady && !settings.isLoading && actions.some((action) => !action.disabled);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const runHoldAction = useCallback((id: string, optionId?: string) => {
    const item = actionsRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    setPending(item.id);
    void (async () => {
      try {
        await item.run(optionId);
      } catch (cause) {
        toast.error(
          `${item.label} failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      } finally {
        setPending(null);
      }
    })();
  }, []);
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

  const ring =
    holdOption || rightClick ? (
      <PointerPie
        title={threadTitle}
        threadKey={targetThreadId}
        actions={actions}
        canOpen={canOpen}
        holdOption={holdOption}
        rightClick={rightClick}
        busy={pending !== null}
        onRun={runHoldAction}
        onUnavailable={(item) =>
          toast(`${item.label} isn't available for this thread`)
        }
      />
    ) : null;

  return holdOption ? (
    ring
  ) : (
    <>
      {ring}
      <TooltipProvider delayDuration={250} skipDelayDuration={100}>
      <div
        className="qa-menu"
        data-bb-plugin-root=""
        data-bb-plugin="quick-actions"
        data-trigger={trigger}
        data-corner={corner}
        data-motion={motion}
        data-debug={debugRegions ? "true" : "false"}
        data-open={requestedOpen ? "true" : "false"}
        data-can-open={canOpen ? "true" : "false"}
        style={position}
        role="group"
        aria-label="Quick actions"
        aria-busy={!threadReady || settings.isLoading || pending !== null}
        onPointerEnter={() => {
          if (canOpen) open();
        }}
        onPointerLeave={(event) => {
          if (!event.currentTarget.contains(document.activeElement)) {
            close();
          }
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) close();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          closeAndFocus();
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
        <div
          id="qa-actions"
          className="qa-actions"
          inert={!requestedOpen || !canOpen}
        >
          {actions.map((item, index) => (
            <Hint key={item.id} label={item.label} side={tooltipSide}>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="qa-action"
                style={actionCssVariables({
                  index,
                  count: actions.length,
                  corner,
                })}
                aria-label={item.label}
                disabled={item.disabled || pending !== null}
                tabIndex={requestedOpen && canOpen ? 0 : -1}
                onClick={() => void activate(item)}
              >
                <Icon name={item.icon} />
              </Button>
            </Hint>
          ))}
        </div>
      </div>
      </TooltipProvider>
    </>
  );
});

function ThreadQuickActions({ threadId }: { threadId: string }) {
  const sdk = useSdk();
  const sidebar = experimental_useSidebarThreads();
  const [fetched, setFetched] = useState<PluginThreadActionTarget | null>(null);
  const [fetchedTitle, setFetchedTitle] = useState<string | null>(null);
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
        setFetchedTitle(result.title ?? null);
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
  const threadTitle =
    listed?.displayTitle ?? (fetched?.id === threadId ? fetchedTitle : null);
  return displayThread ? (
    <QuickActionsMenu
      thread={displayThread}
      threadTitle={threadTitle}
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
  app.slots.settingsSection({
    id: "actions",
    title: "Actions",
    component: ActionsSettings,
  });
});
