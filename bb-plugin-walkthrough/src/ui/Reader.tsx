// The reading view, shared by the thread panel and the full page: a glass top
// bar, one page at a time on a notebook page, a sticky glass pager, and a
// concerns sheet that overlays from the right without reflowing the page.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { comparedWith, parseCommand } from "../model.ts";
import { PAGE_PATH, PANEL_ACTION_ID, type DeliveredWalkthrough as Walkthrough, type NoteKind, type WalkthroughView } from "../schemas.ts";
import { ConcernsSheet, hasReview, openConcerns, type ConcernsTab } from "./Concerns.tsx";
import { figureSelection, type FlagTarget } from "./Figure.tsx";
import { FlagPopover } from "./Flag.tsx";
import { PART_STATE_LABEL, pageAt, pagePosition, partState, suggestionsFor, type PageId, type PartState } from "./fields.ts";
import { Hint } from "./Hint.tsx";
import { errorMessage, useStreams, useWidth, type WalkthroughRpc } from "./hooks.ts";
import { Introduction, PartPage, Skeleton, Thread, WrapUpPage } from "./Pages.tsx";
import { Pager } from "./Pager.tsx";
import { Prose } from "./prose.tsx";
import { partPreview, previewFor, StreamContext, useStreamedView } from "./stream.ts";

/** The width from which notes hang in the right margin instead of stacking under the figure. */
const WIDE_FROM = 900;

/** Whether the wrap-up (rather than a part) is what the reader is looking at. */
function showsWrapUp(walkthrough: Walkthrough, leftWrapUp: boolean): boolean {
  return !leftWrapUp && (walkthrough.status === "wrapping-up" || (walkthrough.status === "done" && walkthrough.wrapUp !== null));
}

/** What the walkthrough is about: the PR it reviews, or the base the changes are measured against. */
function Subject({ walkthrough }: { walkthrough: Walkthrough }) {
  const { pr } = walkthrough;
  if (walkthrough.mode !== "pr" || !pr) {
    const compared = comparedWith(walkthrough);
    return <>{compared.startsWith("everything") ? compared : `Your changes ${compared}`}</>;
  }
  // `pr.title` is GitHub's; the walkthrough's own title is the helper's paraphrase.
  const label = `#${pr.number} ${pr.title ?? walkthrough.title}${pr.state && pr.state !== "open" ? ` (${pr.state})` : ""}`;
  if (!pr.url) return <>PR {label}</>;
  return (
    <UrlLink href={pr.url} className="wt-link">
      {label}
    </UrlLink>
  );
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !== null;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function Reader({ threadId, view, rpc, surface }: { threadId: string; view: WalkthroughView; rpc: WalkthroughRpc; surface: "panel" | "page" }) {
  void threadId;
  const { walkthrough, notes } = view;
  const navigate = useBbNavigate();
  const [rootRef, width] = useWidth<HTMLDivElement>();
  const wide = width >= WIDE_FROM;
  // The concerns sheet stops above the pager so its footer actions stay reachable.
  useEffect(() => {
    const root = rootRef.current;
    const pager = root?.querySelector<HTMLElement>(".wt-pager");
    if (!root || !pager || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => root.style.setProperty("--wt-pager-h", `${pager.offsetHeight + 12}px`));
    observer.observe(pager);
    return () => observer.disconnect();
  }, [rootRef]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [tab, setTab] = useState<ConcernsTab>("open");
  const [finishing, setFinishing] = useState(false);
  // Wrap-up is a state of the walkthrough, but the reader can still go back to
  // the parts from it; this only picks what is shown.
  const [leftWrapUp, setLeftWrapUp] = useState(false);
  const [flag, setFlag] = useState<{ target: FlagTarget; top: number; left: number } | null>(null);
  const [scope, setScope] = useState<FlagTarget | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  const streams = useStreams(walkthrough.id, walkthrough.inFlight ? String(walkthrough.inFlight.sentAt) : null, rpc);
  const partCount = walkthrough.parts.length;
  const wrapUpShown = showsWrapUp(walkthrough, leftWrapUp);
  const preparing = walkthrough.status === "planning" || (walkthrough.status === "failed" && partCount === 0);
  const page: PageId = wrapUpShown ? { kind: "wrap-up" } : walkthrough.currentPart === null ? { kind: "intro" } : { kind: "part", index: Math.min(walkthrough.currentPart, Math.max(0, partCount - 1)) };
  const position = pagePosition(page, partCount);
  const total = partCount + 2;
  const openCount = openConcerns(notes).length;
  const closed = walkthrough.status === "done";
  const activePart = page.kind === "part" ? walkthrough.parts[page.index]! : page.kind === "wrap-up" ? walkthrough.wrapUp : null;

  // Keep the tab title in step with the walkthrough once it has one.
  const titled = useRef<string | null>(null);
  useEffect(() => {
    if (surface !== "panel" || walkthrough.title === "Walkthrough" || titled.current === walkthrough.title) return;
    titled.current = walkthrough.title;
    navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: walkthrough.title, params: { walkthroughId: walkthrough.id } });
  }, [navigate, surface, walkthrough.id, walkthrough.title]);

  useEffect(() => {
    if (walkthrough.status === "wrapping-up") setLeftWrapUp(false);
  }, [walkthrough.status]);

  // Each page starts at its top; a flag or scope belongs to the page it was made on.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setFlag(null);
    setScope(null);
  }, [position]);

  // A new answer in the thread scrolls into view, without a jump when motion is reduced.
  const exchangeCount = activePart?.discussion.length ?? 0;
  const lastCount = useRef(exchangeCount);
  useEffect(() => {
    if (exchangeCount > lastCount.current) threadEndRef.current?.scrollIntoView?.({ block: "nearest", behavior: window.matchMedia?.(REDUCED_MOTION).matches ? "auto" : "smooth" });
    lastCount.current = exchangeCount;
  }, [exchangeCount, position]);

  const closeSheet = useCallback(() => {
    const focusWasInside = sheetRef.current?.contains(document.activeElement) ?? false;
    setSheetOpen(false);
    if (focusWasInside || document.activeElement === document.body) toggleRef.current?.focus();
  }, []);
  const openSheet = (next?: ConcernsTab) => {
    if (next) setTab(next);
    setSheetOpen(true);
  };

  // Opening the sheet moves focus into it.
  useEffect(() => {
    if (!sheetOpen) return;
    const frame = requestAnimationFrame(() => sheetRef.current?.querySelector<HTMLElement>("[role=tab][aria-selected=true]")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [sheetOpen]);

  // Escape closes the sheet from anywhere, except while one of our own dialogs
  // has its own Escape. A dialog that contains the reader is BB's overlay for a
  // narrow side panel; the sheet closes first there and the panel stays open.
  useEffect(() => {
    if (!sheetOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const root = rootRef.current;
      const ownDialogOpen = Array.from(document.querySelectorAll("[role=dialog]:not([data-state=closed])")).some((dialog) => !root || !dialog.contains(root));
      if (ownDialogOpen) return;
      event.stopPropagation();
      event.preventDefault();
      closeSheet();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [sheetOpen, closeSheet, rootRef]);

  const fail = (cause: unknown) => toast.error(errorMessage(cause));
  const openPart = (index: number | null) => {
    if (wrapUpShown) setLeftWrapUp(true);
    rpc.call("openPart", { walkthroughId: walkthrough.id, index }).catch(fail);
  };
  const canWrapUp = walkthrough.status === "reading" || walkthrough.status === "wrapping-up" || (closed && walkthrough.wrapUp !== null);
  const goTo = (next: number) => {
    const target = pageAt(Math.max(0, Math.min(total - 1, next)), partCount);
    if (target.kind === "wrap-up") {
      if (!canWrapUp) return;
      setLeftWrapUp(false);
      if (walkthrough.status === "reading") rpc.call("wrapUp", { walkthroughId: walkthrough.id }).catch(fail);
    } else openPart(target.kind === "intro" ? null : target.index);
  };

  const nextTitle = (() => {
    if (preparing || position >= total - 1) return null;
    if (position === total - 2) return canWrapUp && !closed ? "Wrap up" : walkthrough.wrapUp ? "Wrap-up" : null;
    return `Next: ${walkthrough.parts[position]!.title}`;
  })();

  // The pager's question input: asks the worker about the page, or records a dotted note command.
  const place = page.kind === "part" ? page.index : "wrap-up";
  const askable = !preparing && !closed && page.kind !== "intro" && activePart?.status === "ready";
  const replying = preparing && walkthrough.status !== "failed" && walkthrough.message !== null && walkthrough.inFlight === null;
  const placeholder = replying ? "Reply…" : askable ? (page.kind === "wrap-up" ? "Ask anything" : "Ask about this part") : null;
  const submit = async (text: string) => {
    if (replying) return rpc.call("reply", { walkthroughId: walkthrough.id, text });
    const command = parseCommand(text);
    if (command.kind === "record") {
      const note = await rpc.call("addNote", { walkthroughId: walkthrough.id, kind: command.noteKind, text: command.text, groupIndex: page.kind === "part" ? page.index : null });
      toast.success(`Saved ${note.kind === "question" ? "question" : note.kind} ${note.id}`);
      return;
    }
    if (command.kind === "incomplete") throw new Error(`Add text after .${command.noteKind} to save it.`);
    const about = scope?.quote ? `About “${scope.quote.replace(/\s+/gu, " ").slice(0, 400)}”${scope.location?.startLine ? ` (${scope.location.path}:${scope.location.startLine})` : ""}: ` : "";
    await rpc.call("ask", { walkthroughId: walkthrough.id, place, question: `${about}${command.text}` });
    setScope(null);
  };
  const busy = (activePart?.discussion ?? []).some((exchange) => exchange.status === "queued" || exchange.status === "answering");
  // While a part is being written its follow-up questions show as soon as their block closes, and can be asked once it is saved.
  const pagePreview = useStreamedView(page.kind === "part" ? partPreview(streams, walkthrough, page.index) : null);
  const suggestionsLocked = !askable && !preparing && !closed && (pagePreview?.suggestions?.length ?? 0) > 0;
  const suggestions = askable && activePart ? suggestionsFor(activePart) : suggestionsLocked ? (pagePreview?.suggestions?.slice(0, 3) ?? []) : [];
  const introPreview = useStreamedView(preparing ? previewFor(streams, walkthrough, "plan", 0) : null);

  // Flagging: a selection in prose or code, or a code line's number.
  const flagKinds: NoteKind[] = useMemo(() => (hasReview(walkthrough) ? ["note", "todo", "comment", "question"] : ["note", "todo", "question"]), [walkthrough]);
  const placeFlag = (target: FlagTarget, rect: { bottom: number; left: number }) => {
    const origin = pageRef.current?.getBoundingClientRect();
    if (!origin) return;
    setFlag({ target, top: rect.bottom - origin.top + 6, left: Math.max(0, Math.min(rect.left - origin.left, origin.width - 260)) });
  };
  const onMouseUp = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("[data-flag]")) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (!selection || selection.rangeCount === 0 || text.length < 3 || (event.target as HTMLElement).closest("button, textarea, input")) {
      setFlag(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const inFigure = figureSelection(range);
    const target: FlagTarget = inFigure ?? { location: null, quote: text.slice(0, 2000) };
    placeFlag(target, range.getBoundingClientRect());
  };
  const saveFlag = async (kind: NoteKind, text: string) => {
    if (!flag) return;
    try {
      const note = await rpc.call("addNote", {
        walkthroughId: walkthrough.id,
        kind,
        text,
        groupIndex: page.kind === "part" ? page.index : null,
        location: flag.target.location ?? null,
        quote: flag.target.quote,
      });
      toast.success(`Saved ${kind === "question" ? "ask" : kind} ${note.id}`);
      setFlag(null);
      window.getSelection()?.removeAllRanges();
    } catch (cause) {
      fail(cause);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as Node;
    if (!rootRef.current?.contains(target) || isTyping(event.target) || (event.target instanceof Element && event.target.closest(".wt-code, [role=dialog]"))) return;
    if (event.key === "ArrowRight" || event.key === "j") {
      event.preventDefault();
      goTo(position + 1);
    } else if (event.key === "ArrowLeft" || event.key === "k") {
      event.preventDefault();
      goTo(position - 1);
    } else if (event.key === "/" && placeholder !== null) {
      event.preventDefault();
      inputRef.current?.focus();
    }
  };

  const partItems = [
    { key: "intro", label: "Introduction", state: (preparing ? "pending" : "ready") as PartState, go: 0 },
    ...walkthrough.parts.map((part, index) => ({ key: `p${index}`, label: part.title, state: partState(walkthrough, part), go: index + 1 })),
    {
      key: "wrap",
      label: "Wrap-up",
      state: (walkthrough.wrapUp ? walkthrough.wrapUp.status : walkthrough.status === "wrapping-up" ? "writing" : "pending") as PartState,
      go: total - 1,
    },
  ];
  const [pickerOpen, setPickerOpen] = useState(false);

  const body = (() => {
    if (preparing && introPreview && introPreview.intro !== "") {
      return <Introduction walkthrough={{ ...walkthrough, introduction: introPreview.intro }} onOpen={openPart} streaming={introPreview.introOpen} />;
    }
    if (preparing) return <Preparing walkthrough={walkthrough} />;
    if (page.kind === "wrap-up") return <WrapUpPage walkthrough={walkthrough} notes={notes} draft={view.reviewDraft} rpc={rpc} wide={wide} onFlag={placeFlag} onOpenPart={openPart} onOpenConcerns={() => openSheet("open")} />;
    if (page.kind === "intro") return <Introduction walkthrough={walkthrough} onOpen={openPart} subject={<Subject walkthrough={walkthrough} />} />;
    return <PartPage walkthrough={walkthrough} index={page.index} notes={notes} rpc={rpc} wide={wide} onFlag={placeFlag} />;
  })();
  const marginNumber = page.kind === "part" ? String(page.index + 1) : "·";
  const progressLabel = preparing ? "Getting ready" : `${position + 1} of ${total}`;

  return (
    <TooltipProvider delayDuration={400}>
      <StreamContext.Provider value={streams}>
        <div
          ref={rootRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className={cn("wt", surface === "page" ? "wt-surface-page flex-1" : "wt-surface-panel")}
          data-wide={wide || undefined}
          data-surface={surface}
        >
          <header className="wt-top wt-glass">
            <h1 className="wt-title">{walkthrough.title === "Walkthrough" && walkthrough.request ? walkthrough.request : walkthrough.title}</h1>
            <span className="wt-sp" />
            <span className="wt-dots" aria-hidden>
              {partItems.map((item) => (
                <i key={item.key} className={cn(item.go === position ? "wt-on" : item.go < position ? "wt-past" : "")} />
              ))}
            </span>
            <span className="wt-sp" />
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <button type="button" className="wt-chip" aria-label={`Parts: ${progressLabel}`} disabled={preparing}>
                  {walkthrough.inFlight ? <span className="wt-live" aria-hidden /> : null}
                  {progressLabel}
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="wt-portal wt-picker" mobileTitle="Parts">
                <ol aria-label="Parts">
                  {partItems.map((item) => (
                    <li key={item.key}>
                      <button
                        type="button"
                        aria-current={item.go === position ? "step" : undefined}
                        disabled={item.key === "wrap" && !canWrapUp}
                        onClick={() => {
                          setPickerOpen(false);
                          goTo(item.go);
                        }}
                      >
                        <span className="wt-picker-n">{item.key === "intro" || item.key === "wrap" ? "·" : item.go}</span>
                        <span className="wt-picker-t">{item.label}</span>
                        <span className={cn("wt-status", `wt-status-${item.state}`)}>{PART_STATE_LABEL[item.state]}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </PopoverContent>
            </Popover>
            <button
              ref={toggleRef}
              type="button"
              className="wt-chip"
              data-selected={sheetOpen || undefined}
              aria-expanded={sheetOpen}
              aria-controls="walkthrough-concerns"
              onClick={() => (sheetOpen ? closeSheet() : openSheet())}
            >
              {openCount === 0 ? "Concerns" : `Concerns · ${openCount}`}
            </button>
            <DropdownMenu>
              <Hint label="More">
                <DropdownMenuTrigger asChild>
                  <button type="button" className="wt-chip wt-chip-icon" aria-label="More">
                    <Icon name="MoreHorizontal" className="size-4" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
              </Hint>
              <DropdownMenuContent align="end">
                {surface === "panel" ? (
                  <DropdownMenuItem onSelect={() => navigate.toPluginPanel(PAGE_PATH, { subPath: walkthrough.id })}>Open as full page</DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => navigate.toThread(walkthrough.threadId)}>Back to thread</DropdownMenuItem>
                )}
                {!closed ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setFinishing(true)}>Finish walkthrough</DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </header>

          <div ref={scrollRef} className="wt-scroll">
            <div ref={pageRef} className="wt-page" onMouseUp={onMouseUp}>
              <div className="wt-pn" data-bare={preparing || page.kind !== "part" || undefined} aria-hidden>
                PART<b>{preparing ? "·" : marginNumber}</b>
              </div>
              {body}
              {activePart && !preparing && activePart.status === "ready" ? <Thread walkthrough={walkthrough} part={activePart} place={place} /> : null}
              <div ref={threadEndRef} />
              {flag ? (
                <FlagPopover
                  target={flag.target}
                  position={flag}
                  kinds={flagKinds}
                  onSave={saveFlag}
                  onAsk={() => {
                    setScope(flag.target);
                    setFlag(null);
                    window.getSelection()?.removeAllRanges();
                    inputRef.current?.focus();
                  }}
                  onDismiss={() => setFlag(null)}
                />
              ) : null}
            </div>
          </div>

          <Pager
            ref={inputRef}
            canPrev={!preparing && position > 0}
            nextLabel={nextTitle}
            onPrev={() => goTo(position - 1)}
            onNext={() => goTo(position + 1)}
            placeholder={placeholder}
            suggestions={suggestions}
            suggestionsLocked={suggestionsLocked}
            scope={scope?.quote ?? null}
            onClearScope={() => setScope(null)}
            busy={busy}
            onSubmit={submit}
          />

          <ConcernsSheet
            view={view}
            rpc={rpc}
            open={sheetOpen}
            tab={tab}
            onTab={setTab}
            onClose={closeSheet}
            onJump={(index) => {
              closeSheet();
              goTo(index + 1);
            }}
            sheetRef={sheetRef}
          />

          <Dialog open={finishing} onOpenChange={setFinishing}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Finish this walkthrough?</DialogTitle>
                <DialogDescription>
                  This stops the helper agent, so no more parts are written and you can’t ask it more questions. You can still read what is already written.
                  {(() => {
                    const unwritten = walkthrough.parts.filter((part) => part.status !== "ready").length;
                    return unwritten > 0 ? ` ${unwritten === 1 ? "One part has" : `${unwritten} parts have`} not been written yet.` : "";
                  })()}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setFinishing(false)}>
                  Keep reading
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    setFinishing(false);
                    rpc.call("close", { walkthroughId: walkthrough.id }).catch(fail);
                  }}
                >
                  Finish walkthrough
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </StreamContext.Provider>
    </TooltipProvider>
  );
}

/** Before part 1 exists: the worker's question for the reader if it has one, else the shape of the page to come. */
function Preparing({ walkthrough }: { walkthrough: Walkthrough }) {
  const waiting = walkthrough.inFlight !== null;
  if (walkthrough.message && !waiting) {
    return (
      <article>
        <header className="wt-head">
          <p className="wt-lbl">You asked</p>
          <h2>{walkthrough.request || "The changes on this branch"}</h2>
        </header>
        <Prose text={walkthrough.message} context={{ files: walkthrough, codePath: null }} />
      </article>
    );
  }
  if (walkthrough.status === "failed") return <p className="wt-muted">The walkthrough could not be started.</p>;
  return (
    <article aria-busy>
      <Skeleton label="Reading the change and deciding how to explain it…" />
    </article>
  );
}
