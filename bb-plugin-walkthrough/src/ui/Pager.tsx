// The sticky glass pager: suggested questions, Prev, a question input scoped
// to the page on screen, and a named Next. On the wrap-up it also carries the
// walkthrough's primary action, so it never scrolls out of reach.
import { forwardRef, useState, type FormEvent, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { Hint } from "./Hint.tsx";
import { useFail } from "./notices.tsx";
import { ellipsize } from "./highlight.ts";

export interface PagerProps {
  /** Where Prev goes ("Schema"); null when there is nowhere to go back to. */
  prevTitle: string | null;
  /** What the Next button says; null when there is nothing after this page. */
  nextLabel: string | null;
  /** Next is shown but cannot be pressed yet: the page it leads to, or this one, is still being written. */
  nextWaiting?: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** The input's placeholder; it is always present so the bar never reads as empty. */
  placeholder: string;
  /** The input explains why it cannot take a question right now instead of disappearing. */
  inputDisabled?: boolean;
  suggestions: string[];
  /** Suggestions are shown but cannot be asked yet: the part is still being written. */
  suggestionsLocked?: boolean;
  /** Text from the selection the next question is about. */
  scope: string | null;
  onClearScope: () => void;
  busy: boolean;
  onSubmit: (text: string) => Promise<unknown>;
  /** The wrap-up's actions, pinned above the input row. */
  actions?: ReactNode;
}

export const Pager = forwardRef<HTMLInputElement, PagerProps>(function Pager(
  { prevTitle, nextLabel, nextWaiting = false, onPrev, onNext, placeholder, inputDisabled = false, suggestions, suggestionsLocked = false, scope, onClearScope, busy, onSubmit, actions },
  inputRef,
) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const fail = useFail();
  const send = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || sending || inputDisabled) return;
    setSending(true);
    try {
      await onSubmit(trimmed);
      setText("");
    } catch (cause) {
      fail(cause);
    } finally {
      setSending(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(text);
  };
  const prevLabel = prevTitle === null ? "Previous part" : `Previous: ${prevTitle}`;
  return (
    <div className="wt-pager wt-glass" role="group" aria-label="Pager">
      {suggestions.length > 0 && (!inputDisabled || suggestionsLocked) ? (
        <div className="wt-suggest" role="group" aria-label="Suggested questions">
          {suggestions.map((suggestion) => (
            <button key={suggestion} type="button" disabled={busy || sending || suggestionsLocked} onClick={() => void send(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      {scope ? (
        <div className="wt-scope">
          <span className="wt-scope-text">About “{ellipsize(scope, 120)}”</span>
          <button type="button" aria-label="Clear the selection" onClick={onClearScope}>
            <Icon name="X" className="size-3" aria-hidden />
          </button>
        </div>
      ) : null}
      {actions ? <div className="wt-pager-actions">{actions}</div> : null}
      <form className="wt-pager-row" onSubmit={submit}>
        <Hint label={prevLabel}>
          <button type="button" className="wt-btn wt-btn-quiet wt-prev" aria-label={prevLabel} disabled={prevTitle === null} onClick={onPrev}>
            <Icon name="ChevronLeft" className="size-4" aria-hidden />
            <span className="wt-prev-label">Prev</span>
          </button>
        </Hint>
        <label className="wt-input" data-disabled={inputDisabled || undefined}>
          <input
            ref={inputRef}
            value={text}
            readOnly={inputDisabled || sending}
            aria-disabled={inputDisabled || undefined}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(event) => setText(event.target.value)}
          />
          {text.trim() !== "" && !inputDisabled ? (
            <button type="submit" className="wt-send" aria-label="Ask" disabled={sending}>
              <Icon name="ArrowUp" className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </label>
        {nextLabel !== null ? (
          <button type="button" className="wt-btn wt-btn-primary wt-next" disabled={nextWaiting} aria-live="polite" onClick={onNext}>
            <span className="wt-next-label">{nextLabel}</span>
            {nextWaiting ? <span className="wt-live" aria-hidden /> : <Icon name="ChevronRight" className="size-4" aria-hidden />}
          </button>
        ) : null}
      </form>
    </div>
  );
});
