// The sticky glass pager: suggested questions, Prev, a question input scoped
// to the page on screen, and a named Next.
import { forwardRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { errorMessage } from "./hooks.ts";
import { Hint } from "./Hint.tsx";

export interface PagerProps {
  canPrev: boolean;
  /** Null when there is nothing after this page. */
  nextLabel: string | null;
  onPrev: () => void;
  onNext: () => void;
  /** Null hides the question input (the introduction, a finished walkthrough). */
  placeholder: string | null;
  suggestions: string[];
  /** Text from the selection the next question is about. */
  scope: string | null;
  onClearScope: () => void;
  busy: boolean;
  onSubmit: (text: string) => Promise<unknown>;
}

export const Pager = forwardRef<HTMLInputElement, PagerProps>(function Pager(
  { canPrev, nextLabel, onPrev, onNext, placeholder, suggestions, scope, onClearScope, busy, onSubmit },
  inputRef,
) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSubmit(trimmed);
      setText("");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSending(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(text);
  };
  return (
    <div className="wt-pager wt-glass">
      {placeholder !== null && suggestions.length > 0 ? (
        <div className="wt-suggest" role="group" aria-label="Suggested questions">
          {suggestions.map((suggestion) => (
            <button key={suggestion} type="button" disabled={busy || sending} onClick={() => void send(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      {scope ? (
        <div className="wt-scope">
          <span className="wt-scope-text">About “{scope}”</span>
          <button type="button" aria-label="Clear the selection" onClick={onClearScope}>
            <Icon name="X" className="size-3" aria-hidden />
          </button>
        </div>
      ) : null}
      <form className="wt-pager-row" onSubmit={submit}>
        <Hint label="Previous part">
          <button type="button" className="wt-btn wt-btn-quiet wt-btn-icon" aria-label="Previous" disabled={!canPrev} onClick={onPrev}>
            <Icon name="ChevronLeft" className="size-4" aria-hidden />
          </button>
        </Hint>
        {placeholder !== null ? (
          <label className="wt-input">
            <input
              ref={inputRef}
              value={text}
              disabled={sending}
              placeholder={placeholder}
              aria-label={placeholder}
              onChange={(event) => setText(event.target.value)}
            />
            {text.trim() !== "" ? (
              <button type="submit" className="wt-send" aria-label="Ask" disabled={sending}>
                <Icon name="ArrowUp" className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </label>
        ) : (
          <span className="wt-sp" />
        )}
        {nextLabel !== null ? (
          <button type="button" className="wt-btn wt-btn-primary wt-next" onClick={onNext}>
            <span className="wt-next-label">{nextLabel}</span>
            <Icon name="ChevronRight" className="size-4" aria-hidden />
          </button>
        ) : null}
      </form>
    </div>
  );
});
