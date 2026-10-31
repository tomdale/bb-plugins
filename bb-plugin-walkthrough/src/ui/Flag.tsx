// Flagging a selection or a line: a small toolbar that opens a note composer
// without taking focus from the selection until the reader chooses a kind.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { NoteKind } from "../schemas.ts";
import type { FlagTarget } from "./Figure.tsx";
import { Hint } from "./Hint.tsx";
import { placeFlag, type FlagGeometry, type FlagPosition } from "./place-flag.ts";

export type FlagChoice = NoteKind | "ask";
const LABEL: Record<FlagChoice, string> = { note: "Note", todo: "Todo", comment: "Comment", question: "Question", ask: "Ask" };
const TOOLBAR: NoteKind[] = ["note", "todo", "comment"];
/** What each kind is for, shown while its composer is open. */
const PURPOSE: Record<NoteKind, string> = {
  note: "A note for yourself, kept with this walkthrough.",
  todo: "Something to do. You can hand it to your thread.",
  comment: "A review comment on this line. Include it in the review from Concerns.",
  question: "A question for the helper.",
};

export function FlagPopover({
  target,
  geometry,
  commentReason,
  onSave,
  onAsk,
  onDismiss,
  onReserve,
}: {
  target: FlagTarget;
  geometry: FlagGeometry;
  /** Why Comment is unavailable (shown beside the disabled option), or null when it is offered. */
  commentReason: string | null;
  onSave: (kind: NoteKind, text: string) => Promise<void>;
  onAsk: () => void;
  onDismiss: () => void;
  /** Called with how far the selection's block must move down to leave room for the box (0 when none). */
  onReserve?: (push: number) => void;
}) {
  const [kind, setKind] = useState<NoteKind | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const reasonId = useId();
  const box = useRef<HTMLDivElement>(null);
  // Placed from the box's real size, which changes when the composer opens (see place-flag.ts for the rules).
  const [position, setPosition] = useState<FlagPosition>({ top: geometry.anchor.top, left: geometry.anchor.left, side: "pinned" });
  // The box's size is measured, and measured again whenever it changes (fonts and styles settle after the first paint), so placement never rests on a stale height.
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setSize((held) => (held.width === element.offsetWidth && held.height === element.offsetHeight ? held : { width: element.offsetWidth, height: element.offsetHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [kind]);
  useLayoutEffect(() => {
    const next = placeFlag(geometry, size);
    setPosition((held) => (held.top === next.top && held.left === next.left && held.side === next.side && held.push === next.push ? held : next));
  }, [geometry, kind, text, size]);
  useLayoutEffect(() => {
    onReserve?.(position.side === "reserve" ? (position.push ?? 0) : 0);
  }, [position.side, position.push]);
  useEffect(() => {
    if (kind) area.current?.focus();
  }, [kind]);
  const save = async () => {
    const value = text.trim();
    if (!kind || !value || busy) return;
    setBusy(true);
    try {
      await onSave(kind, value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      ref={box}
      role={kind ? "dialog" : "toolbar"}
      aria-label={kind ? `New ${LABEL[kind].toLowerCase()}` : "Flag this"}
      data-flag=""
      data-side={position.side}
      className={cn("wt-flag wt-glass", kind && "wt-flag-open")}
      style={{ top: position.top, left: position.left, transform: "none" }}
      // Pressing a button here must not collapse the selection it was made from.
      onMouseDown={(event) => {
        if (!(event.target instanceof HTMLTextAreaElement)) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onDismiss();
        }
      }}
    >
      {kind === null ? (
        <>
          {TOOLBAR.map((candidate) => {
            const blocked = candidate === "comment" && commentReason !== null;
            // aria-disabled rather than disabled: a disabled button gets no pointer or focus events, so it could not show why.
            const button = (
              <button key={candidate} type="button" aria-disabled={blocked || undefined} aria-describedby={blocked ? reasonId : undefined} onClick={() => (blocked ? undefined : setKind(candidate))}>
                {LABEL[candidate]}
              </button>
            );
            return blocked ? (
              <Hint key={candidate} label={commentReason} side="bottom">
                {button}
              </Hint>
            ) : (
              button
            );
          })}
          <button type="button" onClick={onAsk}>
            {LABEL.ask}
          </button>
          {commentReason !== null ? (
            <span id={reasonId} className="wt-sr">
              Comment unavailable: {commentReason}
            </span>
          ) : null}
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="wt-flag-kind">
            <b>New {LABEL[kind].toLowerCase()}</b>
            <span>{PURPOSE[kind]}</span>
          </p>
          {target.quote ? <blockquote className="wt-flag-quote">{target.quote}</blockquote> : null}
          <textarea
            ref={area}
            value={text}
            rows={2}
            aria-label={`${LABEL[kind]} text`}
            placeholder={`New ${LABEL[kind].toLowerCase()}`}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void save();
              }
            }}
          />
          <div className="wt-flag-actions">
            <button type="button" className="wt-btn wt-btn-quiet" onClick={onDismiss}>
              Cancel
            </button>
            <button type="submit" className="wt-btn wt-btn-primary" disabled={busy || text.trim() === ""}>
              Save
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
