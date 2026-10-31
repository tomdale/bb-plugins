// The reading view, shared by the thread panel and the full page: a glass top
// bar, one page at a time on a notebook page, a sticky glass pager, and a
// concerns sheet that overlays from the right without reflowing the page.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { comparedWith, parseCommand } from "../model.ts";
import { PAGE_PATH, PANEL_ACTION_ID, type DeliveredNote, type DeliveredWalkthrough as Walkthrough, type NoteKind, type WalkthroughView } from "../schemas.ts";
import { ConcernsSheet, countedOpen, hasReview, type ConcernsTab } from "./Concerns.tsx";
import { ReaderContext } from "./context.ts";
import { figureSelection, type FlagTarget } from "./Figure.tsx";
import { FlagPopover } from "./Flag.tsx";
import { PART_STATE_LABEL, flagGlyphs, pageAt, pagePosition, partState, suggestionsFor, type PageId, type PartState } from "./fields.ts";
import { cssEscape, findQuote, snapRangeToWords } from "./highlight.ts";
import { Hint } from "./Hint.tsx";
import { errorMessage, useStreams, useWidth, type WalkthroughRpc } from "./hooks.ts";
import { NoticeContext, useNotices } from "./notices.tsx";
import { Introduction, PartPage, pageTitle, Skeleton, Thread, WrapUpActions, WrapUpPage } from "./Pages.tsx";
import { Pager } from "./Pager.tsx";
import { Prose } from "./prose.tsx";
import { stripReplyWrapper } from "./reply.ts";
import { partPreview, previewFor, StreamContext, useStreamedView } from "./stream.ts";

/** The width from which notes hang in the right margin instead of stacking under the figure. */
const WIDE_FROM = 900;

/** Whether the wrap-up (rather than a part) is what the reader is looking at. */
function showsWrapUp(walkthrough: Walkthrough, leftWrapUp: boolean): boolean {
  return !leftWrapUp && (walkthrough.status === "wrapping-up" || (walkthrough.status === "done" && walkthrough.wrapUp !== null));
}

/** What the walkthrough is about: the PR it reviews, or what its changes are measured against. */
function Subject({ walkthrough, subtitle }: { walkthrough: Walkthrough; subtitle?: string | undefined }) {
  const { pr } = walkthrough;
  if (walkthrough.mode !== "pr" || !pr) {
    if (subtitle) return <>{subtitle}</>;
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
/** How long a second press of Next is ignored if the page never changes (the call failed or the signal was lost). */
const NAV_LOCK_MS = 1500;

/** The reader's notes that sit in prose, not in a figure: they are marked by a highlight and a glyph in the margin. */
function proseNotes(notes: DeliveredNote[], groupIndex: number | null): DeliveredNote[] {
  return notes.filter((note) => note.author === "user" && note.status === "open" && note.location === null && note.quote !== null && note.groupIndex === groupIndex);
}

/**
 * Highlights the span of each prose note and puts its glyph in the margin
 * beside it. The highlight uses the CSS Custom Highlight API, so the page's own
 * elements are never edited; the glyphs are positioned from the span's first
 * line and recomputed whenever the page lays out again.
 */
function ProseFlags({ pageRef, notes, glyphs, onOpen }: { pageRef: React.RefObject<HTMLDivElement | null>; notes: DeliveredNote[]; glyphs: Map<string, string>; onOpen: (note: DeliveredNote) => void }) {
  const [marks, setMarks] = useState<Array<{ note: DeliveredNote; top: number }>>([]);
  const key = (list: Array<{ note: DeliveredNote; top: number }>) => list.map((mark) => `${mark.note.id}:${Math.round(mark.top)}`).join("|");
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const roots = Array.from(page.querySelectorAll<HTMLElement>("article .wt-prose")).filter((element) => !element.closest(".wt-thread"));
    const origin = page.getBoundingClientRect().top;
    const found: Array<{ note: DeliveredNote; top: number; range: Range }> = [];
    for (const note of notes) {
      const range = note.quote ? findQuote(roots, note.quote) : null;
      if (!range) continue;
      const rect = range.getClientRects?.()[0] ?? range.getBoundingClientRect?.();
      found.push({ note, top: (rect?.top ?? origin) - origin, range });
    }
    const registry = typeof CSS !== "undefined" ? (CSS.highlights as unknown as Map<string, Highlight> | undefined) : undefined;
    if (registry && typeof Highlight !== "undefined") registry.set("wt-note", new Highlight(...found.map((entry) => entry.range)));
    const next = found.map(({ note, top }) => ({ note, top }));
    setMarks((current) => (key(current) === key(next) ? current : next));
    return () => {
      registry?.delete("wt-note");
    };
  });
  return (
    <>
      {marks.map(({ note, top }) => (
        <button
          key={note.id}
          type="button"
          className="wt-m wt-m-own wt-prose-flag"
          style={{ top }}
          data-note-glyph={note.id}
          aria-label={`Your ${note.kind === "question" ? "ask" : note.kind} ${glyphs.get(note.id) ?? ""}: ${note.text}`}
          onClick={() => onOpen(note)}
        >
          {glyphs.get(note.id) ?? "•"}
        </button>
      ))}
    </>
  );
}

export function Reader({ threadId, view, rpc, surface }: { threadId: string; view: WalkthroughView; rpc: WalkthroughRpc; surface: "panel" | "page" }) {
  void threadId;
  const { walkthrough, notes } = view;
  const navigate = useBbNavigate();
  const { notify, stack } = useNotices();
  const fail = useCallback((cause: unknown) => notify(errorMessage(cause), "error"), [notify]);
  const [rootRef, width] = useWidth<HTMLDivElement>();
  const wide = width >= WIDE_FROM;
  // The concerns sheet and the toasts stop above the pager so its controls stay reachable.
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
  const [flag, setFlag] = useState<{ target: FlagTarget; top: number; left: number; above: boolean } | null>(null);
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
  const openCount = countedOpen(notes).length;
  const closed = walkthrough.status === "done";
  const activePart = page.kind === "part" ? walkthrough.parts[page.index]! : page.kind === "wrap-up" ? walkthrough.wrapUp : null;
  const title = pageTitle(walkthrough);
  const glyphs = useMemo(() => flagGlyphs(notes), [notes]);
  const canComment = hasReview(walkthrough);
  const readerContext = useMemo(() => ({ glyphs, canComment, commentReason: "Comments are for pull requests" }), [glyphs, canComment]);

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

  // One move at a time. A press of Next while the last one is still arriving would
  // be read from the old page and skip one; the lock lifts when the page changes
  // (or after a moment, if the call failed).
  const navigating = useRef(false);
  const [navBusy, setNavBusy] = useState(false);
  const lockNavigation = () => {
    navigating.current = true;
    setNavBusy(true);
  };
  useEffect(() => {
    navigating.current = false;
    setNavBusy(false);
  }, [position]);
  useEffect(() => {
    if (!navBusy) return;
    const timer = setTimeout(() => {
      navigating.current = false;
      setNavBusy(false);
    }, NAV_LOCK_MS);
    return () => clearTimeout(timer);
  }, [navBusy]);

  const openPart = (index: number | null) => {
    if (navigating.current) return;
    lockNavigation();
    if (wrapUpShown) setLeftWrapUp(true);
    rpc.call("openPart", { walkthroughId: walkthrough.id, index }).catch((cause: unknown) => {
      navigating.current = false;
      setNavBusy(false);
      fail(cause);
    });
  };
  const canWrapUp = walkthrough.status === "reading" || walkthrough.status === "wrapping-up" || (closed && walkthrough.wrapUp !== null);
  const goTo = (next: number) => {
    const clamped = Math.max(0, Math.min(total - 1, next));
    if (clamped === position || navigating.current) return;
    const target = pageAt(clamped, partCount);
    if (target.kind === "wrap-up") {
      if (!canWrapUp) return;
      lockNavigation();
      setLeftWrapUp(false);
      if (walkthrough.status === "reading") {
        rpc.call("wrapUp", { walkthroughId: walkthrough.id }).catch((cause: unknown) => {
          navigating.current = false;
          setNavBusy(false);
          fail(cause);
        });
      }
    } else openPart(target.kind === "intro" ? null : target.index);
  };

  // What Next says, and whether it can be pressed. Next waits while the page it leads to, or the one on screen, is still being written.
  const pending = (status: string) => status === "writing" || status === "pending";
  const currentWriting = !closed && page.kind === "part" && pending(walkthrough.parts[page.index]!.status);
  const next = (() => {
    if (preparing || position >= total - 1) return { label: null as string | null, waiting: false };
    if (position === total - 2) {
      const label = canWrapUp && !closed ? "Wrap up" : walkthrough.wrapUp ? "Wrap-up" : null;
      return currentWriting && label !== null ? { label: "Writing…", waiting: true } : { label, waiting: false };
    }
    const upcoming = walkthrough.parts[position]!;
    if (currentWriting || (!closed && upcoming.status === "writing")) return { label: "Writing…", waiting: true };
    return { label: `Next: ${upcoming.title}`, waiting: false };
  })();
  const prevTitle = (() => {
    if (preparing || position === 0) return null;
    const before = pageAt(position - 1, partCount);
    return before.kind === "intro" ? "Introduction" : before.kind === "part" ? walkthrough.parts[before.index]!.title : null;
  })();

  // The pager's question input: asks the worker about the page, or records a dotted note command.
  const place = page.kind === "part" ? page.index : "wrap-up";
  const replying = preparing && walkthrough.status !== "failed" && walkthrough.message !== null && walkthrough.inFlight === null;
  const input = (() => {
    if (replying) return { placeholder: "Reply…", disabled: false };
    if (closed) return { placeholder: "This walkthrough is finished", disabled: true };
    if (preparing) return { placeholder: "You can ask once the first part is ready", disabled: true };
    if (page.kind === "intro") return { placeholder: "Open a part to ask about it", disabled: true };
    if (activePart?.status !== "ready") return { placeholder: "You can ask once this page is written", disabled: true };
    return { placeholder: page.kind === "wrap-up" ? "Ask anything" : "Ask about this part", disabled: false };
  })();
  const askable = !input.disabled && !replying;
  const submit = async (text: string) => {
    if (replying) return rpc.call("reply", { walkthroughId: walkthrough.id, text });
    const command = parseCommand(text);
    if (command.kind === "record") {
      const note = await rpc.call("addNote", { walkthroughId: walkthrough.id, kind: command.noteKind, text: command.text, groupIndex: page.kind === "part" ? page.index : null });
      notify(`${command.noteKind === "question" ? "Question" : note.kind[0]!.toUpperCase() + note.kind.slice(1)} saved`);
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

  // Flagging: a selection in prose or code, or a code line.
  // The toolbar sits above the selection so it never covers the next line; at the top edge of the page it drops below.
  const placeFlag = (target: FlagTarget, rect: { top: number; bottom: number; left: number }) => {
    const origin = pageRef.current?.getBoundingClientRect();
    if (!origin) return;
    const above = rect.top - (scrollRef.current?.getBoundingClientRect().top ?? 0) > 56;
    setFlag({ target, above, top: above ? rect.top - origin.top - 6 : rect.bottom - origin.top + 6, left: Math.max(0, Math.min(rect.left - origin.left, origin.width - 260)) });
  };
  const onMouseUp = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest("[data-flag]")) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || (event.target as HTMLElement).closest("button, textarea, input")) {
      setFlag(null);
      return;
    }
    // A note never starts or ends mid-word: the selection grows to whole words first.
    const range = snapRangeToWords(selection.getRangeAt(0));
    const text = selection.toString().trim();
    if (text.length < 3) {
      setFlag(null);
      return;
    }
    const inFigure = figureSelection(range);
    const target: FlagTarget = inFigure ?? { location: null, quote: text.slice(0, 2000) };
    placeFlag(target, range.getBoundingClientRect());
  };
  // Saving a note can change the page's height (a margin note appears, a figure grows); the line the reader flagged stays where it was on screen.
  const anchor = useRef<{ selector: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const held = anchor.current;
    const scroller = scrollRef.current;
    if (!held || !scroller) return;
    anchor.current = null;
    const element = pageRef.current?.querySelector(held.selector);
    if (element) scroller.scrollTop += element.getBoundingClientRect().top - held.top;
  }, [notes]);
  const saveFlag = async (kind: NoteKind, text: string) => {
    if (!flag) return;
    const { location } = flag.target;
    if (location?.startLine !== undefined) {
      const selector = `figure[data-code-path="${cssEscape(location.path)}"] [data-line="${location.startLine}"]`;
      const element = pageRef.current?.querySelector(selector);
      if (element) anchor.current = { selector, top: element.getBoundingClientRect().top };
    }
    try {
      await rpc.call("addNote", {
        walkthroughId: walkthrough.id,
        kind,
        text,
        groupIndex: page.kind === "part" ? page.index : null,
        location: location ?? null,
        quote: flag.target.quote,
      });
      notify(`${kind === "question" ? "Question" : kind[0]!.toUpperCase() + kind.slice(1)} saved`);
      setFlag(null);
      window.getSelection()?.removeAllRanges();
    } catch (cause) {
      anchor.current = null;
      fail(cause);
    }
  };

  // Jumping to a concern: its part, then its line (or the highlighted span in prose), flashed once.
  const [jump, setJump] = useState<{ note: DeliveredNote; nonce: number } | null>(null);
  const jumpTo = (note: DeliveredNote) => {
    closeSheet();
    if (note.groupIndex !== null) goTo(note.groupIndex + 1);
    setJump({ note, nonce: Date.now() });
  };
  useEffect(() => {
    if (!jump) return;
    const wanted = jump.note.groupIndex === null ? position : jump.note.groupIndex + 1;
    if (position !== wanted) return;
    let frames = 0;
    let handle = 0;
    const attempt = () => {
      const { location } = jump.note;
      const root = pageRef.current;
      const element =
        location?.startLine !== undefined
          ? root?.querySelector<HTMLElement>(`figure[data-code-path="${cssEscape(location.path)}"] [data-line="${location.startLine}"]`)
          : root?.querySelector<HTMLElement>(`[data-note-glyph="${cssEscape(jump.note.id)}"]`);
      if (element) {
        element.scrollIntoView?.({ block: "center", behavior: window.matchMedia?.(REDUCED_MOTION).matches ? "auto" : "smooth" });
        element.setAttribute("data-flash", "");
        window.setTimeout(() => element.removeAttribute("data-flash"), 1600);
        setJump(null);
      } else if (++frames < 40) handle = requestAnimationFrame(attempt);
      else setJump(null);
    };
    attempt();
    return () => cancelAnimationFrame(handle);
  }, [jump, position, walkthrough.updatedAt]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as Node;
    if (!rootRef.current?.contains(target) || isTyping(event.target) || (event.target instanceof Element && event.target.closest("[role=dialog]"))) return;
    if (event.key === "ArrowRight" || event.key === "j") {
      event.preventDefault();
      goTo(position + 1);
    } else if (event.key === "ArrowLeft" || event.key === "k") {
      event.preventDefault();
      goTo(position - 1);
    } else if (event.key === "/" && askable) {
      event.preventDefault();
      inputRef.current?.focus();
    } else if (event.key === "c" && event.target instanceof Element) {
      // `c` flags the line the keyboard is on: a focused line number, or the figure's own cursor (handled by the figure).
      const number = event.target.closest<HTMLButtonElement>("button.wt-ln");
      if (number) {
        event.preventDefault();
        number.click();
      }
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
      return <Introduction walkthrough={{ ...walkthrough, introduction: introPreview.intro }} onOpen={openPart} streaming={introPreview.introOpen} label={view.copy?.introduction ?? "Introduction"} />;
    }
    if (preparing) return <Preparing walkthrough={walkthrough} skeleton={view.copy?.skeleton} />;
    if (page.kind === "wrap-up") return <WrapUpPage walkthrough={walkthrough} notes={notes} draft={view.reviewDraft} coverage={view.coverage} rpc={rpc} wide={wide} onFlag={placeFlag} onOpenPart={openPart} onOpenConcerns={() => openSheet("open")} />;
    if (page.kind === "intro") return <Introduction walkthrough={walkthrough} onOpen={openPart} coverage={view.coverage} label={view.copy?.introduction ?? "Introduction"} />;
    return <PartPage walkthrough={walkthrough} index={page.index} notes={notes} rpc={rpc} wide={wide} onFlag={placeFlag} />;
  })();
  // One counting scheme everywhere: parts are numbered 1…N; the introduction and wrap-up are named, never numbered.
  const progressLabel = preparing ? "Getting ready" : page.kind === "intro" ? "Introduction" : page.kind === "wrap-up" ? "Wrap-up" : `Part ${page.index + 1} of ${partCount}`;
  const pageNotes = proseNotes(notes, page.kind === "part" ? page.index : null);

  return (
    <TooltipProvider delayDuration={400}>
      <StreamContext.Provider value={streams}>
        <NoticeContext.Provider value={notify}>
          <ReaderContext.Provider value={readerContext}>
            <div
              ref={rootRef}
              tabIndex={-1}
              onKeyDown={onKeyDown}
              className={cn("wt", surface === "page" ? "wt-surface-page flex-1" : "wt-surface-panel")}
              data-wide={wide || undefined}
              data-surface={surface}
            >
              <header className="wt-top wt-glass">
                <h1 className="wt-title" data-placeholder={title.placeholder || undefined}>
                  {title.text}
                </h1>
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
                  <div className="wt-pn" aria-hidden>
                    {page.kind === "part" && !preparing ? (
                      <>
                        PART<b>{page.index + 1}</b>
                      </>
                    ) : page.kind === "wrap-up" && !preparing ? (
                      "WRAP-UP"
                    ) : (
                      "INTRO"
                    )}
                  </div>
                  {page.kind === "intro" && (!preparing || introPreview !== null) ? (
                    <p className="wt-subject">{preparing ? "\u00a0" : <Subject walkthrough={walkthrough} subtitle={view.copy?.subtitle} />}</p>
                  ) : null}
                  {body}
                  {activePart && !preparing && activePart.status === "ready" ? <Thread walkthrough={walkthrough} part={activePart} place={place} /> : null}
                  <div ref={threadEndRef} />
                  <ProseFlags pageRef={pageRef} notes={pageNotes} glyphs={glyphs} onOpen={() => openSheet("open")} />
                  {flag ? (
                    <FlagPopover
                      target={flag.target}
                      position={flag}
                      commentReason={canComment ? null : readerContext.commentReason}
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
                prevTitle={prevTitle}
                nextLabel={next.label}
                nextWaiting={next.waiting || (navBusy && next.label !== null)}
                onPrev={() => goTo(position - 1)}
                onNext={() => goTo(position + 1)}
                placeholder={input.placeholder}
                inputDisabled={input.disabled}
                suggestions={suggestions}
                suggestionsLocked={suggestionsLocked}
                scope={scope?.quote ?? null}
                onClearScope={() => setScope(null)}
                busy={busy}
                onSubmit={submit}
                actions={page.kind === "wrap-up" && !preparing ? <WrapUpActions walkthrough={walkthrough} notes={notes} draft={view.reviewDraft} rpc={rpc} /> : undefined}
              />
              {stack}

              <ConcernsSheet view={view} rpc={rpc} open={sheetOpen} tab={tab} onTab={setTab} onClose={closeSheet} onJump={jumpTo} sheetRef={sheetRef} />

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
          </ReaderContext.Provider>
        </NoticeContext.Provider>
      </StreamContext.Provider>
    </TooltipProvider>
  );
}

/** Before part 1 exists: the worker's question for the reader if it has one, else the shape of the page to come. */
function Preparing({ walkthrough, skeleton }: { walkthrough: Walkthrough; skeleton?: string | undefined }) {
  const waiting = walkthrough.inFlight !== null;
  if (walkthrough.message && !waiting) {
    return (
      <article>
        <header className="wt-head">
          <p className="wt-lbl">You asked</p>
          <h2>{walkthrough.request || "The changes on this branch"}</h2>
        </header>
        <Prose text={stripReplyWrapper(walkthrough.message)} context={{ files: walkthrough, codePath: null }} />
      </article>
    );
  }
  if (walkthrough.status === "failed") return <p className="wt-muted">The walkthrough could not be started.</p>;
  return (
    <article aria-busy>
      <Skeleton label={skeleton ?? "Reading the change and deciding how to explain it…"} />
    </article>
  );
}
