// Flagging a selection or a line: a small toolbar that opens a note composer
// without taking focus from the selection until the reader chooses a kind.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { NoteKind } from "../schemas.ts";
import type { FlagTarget } from "./Figure.tsx";
import { Hint } from "./Hint.tsx";
import { flagTop, type FlagPlacement } from "./place-flag.ts";

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
  position,
  commentReason,
  onSave,
  onAsk,
  onDismiss,
}: {
  target: FlagTarget;
  position: FlagPlacement & { left: number };
  /** Why Comment is unavailable (shown beside the disabled option), or null when it is offered. */
  commentReason: string | null;
  onSave: (kind: NoteKind, text: string) => Promise<void>;
  onAsk: () => void;
  onDismiss: () => void;
}) {
  const [kind, setKind] = useState<NoteKind | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const reasonId = useId();
  const box = useRef<HTMLDivElement>(null);
  // Placed from the box's real height, which changes when the composer opens: it never runs under the top bar or the pager.
  const [top, setTop] = useState(position.anchorTop);
  useLayoutEffect(() => {
    const height = box.current?.offsetHeight ?? 0;
    setTop(flagTop(position, height));
  }, [position, kind, text]);
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
      className={cn("wt-flag wt-glass", kind && "wt-flag-open")}
      style={{ top, left: position.left, transform: "none" }}
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
