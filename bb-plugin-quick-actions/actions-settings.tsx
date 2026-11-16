/**
 * The Actions settings section: the ring as it will open, beside the same
 * actions as a list in ring order, clockwise from the top. The list adds,
 * removes, and reorders BB thread actions; the ring shows where each points.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, KeyboardEvent, ReactElement } from "react";
import {
  experimental_useThreadActionRegistrations,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadActionRegistrationInfo } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RING_ACTION_LIMIT, type RingAction } from "./ring-actions";
import { RING_DEAD_ZONE_PX, fitRing, pt, ringType, wedgePath } from "./ring-pie";
import { useRingActions } from "./use-ring-actions";

const CORE_OWNER = "bb--core";

/** Installed plugins' display names by id, for naming an action's owner. */
function usePluginNames(): ReadonlyMap<string, string> {
  const sdk = useSdk();
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let active = true;
    sdk.plugins
      .list()
      .then((result) => {
        if (!active) return;
        const entries = result.plugins.flatMap((plugin) =>
          plugin.name ? [[plugin.id, plugin.name] as const] : [],
        );
        setNames(new Map(entries));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [sdk]);
  return names;
}

type ShownAction = RingAction & { available: boolean; pluginId: string | null };

function RingPreview({ actions, hot }: { actions: readonly ShownAction[]; hot: number | null }) {
  const n = actions.length;
  const { Rd, ri } = fitRing(n, []);
  const type = ringType(n);
  const step = 360 / n;
  return (
    <div
      className="qa-actions-preview"
      aria-hidden="true"
      style={
        {
          width: `${Rd * 2}px`,
          height: `${Rd * 2}px`,
          "--qa-ring-font": `${type.font}px`,
          "--qa-ring-icon": `${type.icon}px`,
          "--qa-ring-gap": `${type.gap}px`,
          "--qa-ring-wrap": `${type.wrap}px`,
        } as CSSProperties
      }
    >
      <svg className="qa-actions-preview-backdrop" viewBox={`${-Rd} ${-Rd} ${Rd * 2} ${Rd * 2}`}>
        <circle r={Rd} className="qa-actions-preview-disc" />
        {hot !== null && n > 1 ? (
          <path
            className="qa-actions-preview-tile"
            d={wedgePath(Rd - 6, RING_DEAD_ZONE_PX + 4, 8, hot * step - step / 2 + 1, hot * step + step / 2 - 1)}
          />
        ) : null}
        <circle r={32} className="qa-actions-preview-hub" />
      </svg>
      {actions.map((action, index) => {
        const [x, y] = pt(ri, index * step);
        return (
          <div
            key={action.key}
            className="qa-actions-preview-item"
            data-hot={hot === index ? "true" : "false"}
            data-available={action.available ? "true" : "false"}
            style={{ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)` }}
          >
            <Icon name={action.icon} />
            <span>{action.title}</span>
          </div>
        );
      })}
      <span className="qa-actions-preview-x">
        <Icon name="X" />
      </span>
    </div>
  );
}

function Hint({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

export function ActionsSettings() {
  const ring = useRingActions();
  const registrations = experimental_useThreadActionRegistrations();
  const pluginNames = usePluginNames();
  const [hot, setHot] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number | null } | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const gripRefs = useRef(new Map<string, HTMLButtonElement>());
  const addRef = useRef<HTMLButtonElement>(null);
  const byKey = useMemo(
    () => new Map(registrations.map((registration) => [registration.key, registration])),
    [registrations],
  );

  // The live registration names and draws an action; the saved copy stands in
  // when its plugin is gone.
  const shown: ShownAction[] = ring.actions.map((action) => {
    const registration = byKey.get(action.key);
    return registration
      ? { key: action.key, title: registration.title, icon: registration.icon, available: true, pluginId: registration.pluginId }
      : { ...action, available: false, pluginId: null };
  });

  useLayoutEffect(() => {
    if (focusKey === null) return;
    gripRefs.current.get(focusKey)?.focus();
    setFocusKey(null);
  }, [focusKey, ring.actions]);

  const save = (next: readonly ShownAction[]) => {
    const actions = next.map(({ key, title, icon }) => ({ key, title, icon }));
    void ring.save(actions).catch((cause: unknown) => {
      toast.error(`Couldn't save the ring: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= shown.length || from === to) return;
    const next = [...shown];
    const [action] = next.splice(from, 1);
    next.splice(to, 0, action!);
    save(next);
  };
  const add = (registration: PluginThreadActionRegistrationInfo) => {
    save([
      ...shown,
      {
        key: registration.key,
        title: registration.title,
        icon: registration.icon,
        available: true,
        pluginId: registration.pluginId,
      },
    ]);
  };
  const remove = (index: number) => {
    save(shown.filter((_, i) => i !== index));
    setHot(null);
    addRef.current?.focus();
  };

  const used = new Set(shown.map((action) => action.key));
  const groups = new Map<string, PluginThreadActionRegistrationInfo[]>();
  for (const registration of registrations) {
    if (used.has(registration.key)) continue;
    const group = groups.get(registration.pluginId) ?? [];
    group.push(registration);
    groups.set(registration.pluginId, group);
  }
  const full = shown.length >= RING_ACTION_LIMIT;
  const ownerName = (pluginId: string) =>
    pluginId === CORE_OWNER ? "BB" : (pluginNames.get(pluginId) ?? pluginId);

  const onGripKey = (event: KeyboardEvent, index: number, key: string) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const to = index + (event.key === "ArrowUp" ? -1 : 1);
    if (to < 0 || to >= shown.length) return;
    move(index, to);
    setHot(to);
    setFocusKey(key);
  };
  const onDragOver = (event: DragEvent<HTMLLIElement>, index: number) => {
    if (!drag) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    const to = event.clientY < box.top + box.height / 2 ? index : index + 1;
    if (to !== drag.to) setDrag({ ...drag, to });
  };
  const onDrop = (event: DragEvent) => {
    if (!drag || drag.to === null) return;
    event.preventDefault();
    move(drag.from, drag.to > drag.from ? drag.to - 1 : drag.to);
    setDrag(null);
  };

  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={100}>
      <div className="qa-actions" aria-busy={!ring.loaded} onPointerLeave={() => setHot(null)}>
        <RingPreview actions={shown} hot={hot} />
        <div className="qa-actions-list">
          <ol aria-label="Ring actions, clockwise from the top" onDrop={onDrop}>
            {shown.map((action, index) => (
              <li
                key={action.key}
                className="qa-actions-row"
                data-hot={hot === index ? "true" : "false"}
                data-dragging={drag?.from === index ? "true" : "false"}
                data-drop={
                  drag && drag.to === index ? "before" : drag && drag.to === index + 1 && index === shown.length - 1 ? "after" : undefined
                }
                draggable={drag?.from === index}
                onPointerEnter={() => setHot(index)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", action.key);
                }}
                onDragOver={(event) => onDragOver(event, index)}
                onDragEnd={() => setDrag(null)}
              >
                <button
                  type="button"
                  ref={(node) => {
                    if (node) gripRefs.current.set(action.key, node);
                    else gripRefs.current.delete(action.key);
                  }}
                  className="qa-actions-grip"
                  aria-label={`Move ${action.title}`}
                  aria-roledescription="sortable"
                  disabled={!ring.loaded}
                  onPointerDown={() => setDrag({ from: index, to: null })}
                  onPointerUp={() => setDrag((current) => (current?.to === null ? null : current))}
                  onKeyDown={(event) => onGripKey(event, index, action.key)}
                  onFocus={() => setHot(index)}
                >
                  <Icon name="DragDropVertical" />
                </button>
                <span
                  className="qa-actions-direction"
                  style={{ transform: `rotate(${(index * 360) / shown.length}deg)` }}
                  aria-hidden="true"
                >
                  <Icon name="ArrowUp" />
                </span>
                <Icon name={action.icon} />
                <span className="qa-actions-title">{action.title}</span>
                <span className="qa-actions-owner">
                  {!action.available
                    ? "Unavailable"
                    : action.pluginId && action.pluginId !== CORE_OWNER
                      ? ownerName(action.pluginId)
                      : null}
                </span>
                <Hint label="Remove">
                  <button
                    type="button"
                    className="qa-actions-remove"
                    aria-label={`Remove ${action.title}`}
                    disabled={!ring.loaded || shown.length === 1}
                    onClick={() => remove(index)}
                  >
                    <Icon name="X" />
                  </button>
                </Hint>
              </li>
            ))}
          </ol>
          <div className="qa-actions-foot">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button ref={addRef} variant="outline" size="sm" disabled={!ring.loaded}>
                  <Icon name="Plus" />
                  Add action
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" mobileTitle="Add action">
                {full ? (
                  <>
                    <DropdownMenuLabel>The ring is full.</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                {[...groups].map(([pluginId, group], index) => (
                  <div key={pluginId}>
                    {index > 0 ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuLabel>{ownerName(pluginId)}</DropdownMenuLabel>
                    {group.map((registration) => (
                      <DropdownMenuItem
                        key={registration.key}
                        disabled={full}
                        onSelect={() => add(registration)}
                      >
                        <Icon name={registration.icon} />
                        {registration.title}
                      </DropdownMenuItem>
                    ))}
                  </div>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {ring.customized ? (
              <Button
                variant="ghost"
                size="sm"
                className="qa-actions-reset"
                disabled={!ring.loaded}
                onClick={() => {
                  void ring.save(null).catch((cause: unknown) => {
                    toast.error(
                      `Couldn't reset the ring: ${cause instanceof Error ? cause.message : String(cause)}`,
                    );
                  });
                }}
              >
                Reset to default
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
