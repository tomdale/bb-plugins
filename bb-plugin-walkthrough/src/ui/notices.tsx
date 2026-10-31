// Short confirmations ("Note saved"). They stack above the pager, never over
// its controls, and clear themselves; errors stay a little longer. Outside a
// reader (the starter) there is no stack, so the host's toast stands in.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { errorMessage } from "./hooks.ts";

export type NoticeTone = "success" | "error" | "info";
export interface Notice {
  id: number;
  tone: NoticeTone;
  message: string;
}
export type Notify = (message: string, tone?: NoticeTone) => void;

const SHORT_MS = 2400;
const ERROR_MS = 6000;
const MAX_VISIBLE = 3;

const fallback: Notify = (message, tone = "success") => (tone === "error" ? toast.error(message) : toast[tone](message));
export const NoticeContext = createContext<Notify>(fallback);

export function useNotify(): Notify {
  return useContext(NoticeContext);
}

/** Reports a failed action in the reader's own words. */
export function useFail(): (cause: unknown) => void {
  const notify = useNotify();
  return useCallback((cause: unknown) => notify(errorMessage(cause), "error"), [notify]);
}

/** State for a stack of notices; render `stack` inside the reader's root and provide `notify` to everything under it. */
export function useNotices(): { notify: Notify; stack: ReactNode } {
  const [notices, setNotices] = useState<Notice[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);
  const notify = useCallback<Notify>(
    (message, tone = "success") => {
      const id = next.current++;
      setNotices((current) => [...current.filter((notice) => notice.message !== message), { id, tone, message }].slice(-MAX_VISIBLE));
      timers.current.set(id, setTimeout(() => dismiss(id), tone === "error" ? ERROR_MS : SHORT_MS));
    },
    [dismiss],
  );
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);
  const stack = useMemo(
    () => (
      <div className="wt-toasts" role="status" aria-live="polite" aria-atomic="false">
        {notices.map((notice) => (
          <div key={notice.id} className="wt-toast" data-tone={notice.tone}>
            <span>{notice.message}</span>
            <button type="button" className="wt-toast-x" aria-label="Dismiss" onClick={() => dismiss(notice.id)}>
              <Icon name="X" className="size-3" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    ),
    [notices, dismiss],
  );
  return { notify, stack };
}
