// The walkthrough pause controls. BB renders this in place of the thread
// composer while `walkthrough_pause` waits. Navigation and questions submit
// the interaction (the agent resumes); recording a note goes straight to the
// server over RPC so the pause stays open and the user keeps reviewing.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  experimental_useQuestionFormHost as useQuestionFormHost,
  useBbNavigate,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatLocation, NOTE_KIND_LABEL, parseCommand, primaryNoteKinds } from "../model.ts";
import { PANEL_ACTION_ID, pausePayloadSchema, type NoteKind, type PausePayload, type PauseResponse } from "../schemas.ts";
import { errorMessage, useWalkthrough } from "./hooks.ts";

type Feedback = { tone: "ok" | "error"; text: string } | null;

/** "12" or "12-40" → a new-side line range; anything else is null. */
function parseLineRange(value: string): { startLine: number; endLine?: number } | null {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/u.exec(value);
  if (match === null) return null;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < 1) return null;
  return start === end ? { startLine: start } : { startLine: Math.min(start, end), endLine: Math.max(start, end) };
}

function primaryLabel(payload: PausePayload): string {
  if (payload.stage === "finish") return "Done";
  if (payload.stage === "overview") return payload.nextGroupTitle ? `Start: ${payload.nextGroupTitle}` : "Start";
  return payload.nextGroupTitle ? `Next: ${payload.nextGroupTitle}` : "Finish walkthrough";
}

export function PauseForm({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = useMemo(() => pausePayloadSchema.safeParse(interaction.payload), [interaction.payload]);
  if (!parsed.success) {
    return (
      <div className="flex items-center gap-3 p-3 text-sm text-muted-foreground">
        The walkthrough controls could not be displayed.
        <Button type="button" variant="outline" size="sm" onClick={() => void cancel().catch(() => {})}>
          Use chat
        </Button>
      </div>
    );
  }
  return <PauseControls key={interaction.id} threadId={interaction.threadId} payload={parsed.data} submit={submit} cancel={cancel} />;
}

function PauseControls({
  threadId,
  payload,
  submit,
  cancel,
}: {
  threadId: string;
  payload: PausePayload;
  submit: PluginPendingInteractionProps["submit"];
  cancel: PluginPendingInteractionProps["cancel"];
}) {
  const { view, rpc } = useWalkthrough(threadId);
  const navigate = useBbNavigate();
  const host = useQuestionFormHost();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [locationIndex, setLocationIndex] = useState(-1);
  const [lines, setLines] = useState("");
  const [showMoreKinds, setShowMoreKinds] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();

  const kinds = primaryNoteKinds(payload.mode);
  const moreKinds = (["question", "todo", "comment", "note"] as NoteKind[]).filter((kind) => !kinds.includes(kind));
  const openNotes = view?.notes.filter((note) => note.status === "open").length ?? 0;
  const trimmed = text.trim();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const respond = (response: PauseResponse) => {
    if (busy) return;
    setBusy(true);
    void submit(response).catch((cause: unknown) => {
      setBusy(false);
      setFeedback({ tone: "error", text: errorMessage(cause) });
    });
  };

  const openPanel = () => {
    if (!navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: "Walkthrough" })) {
      setFeedback({ tone: "error", text: "The Walkthrough panel is not available on this surface." });
    }
  };

  const record = async (kind: NoteKind, noteText: string) => {
    const base = locationIndex >= 0 ? payload.locations[locationIndex] ?? null : null;
    const range = parseLineRange(lines);
    const location = base && (range ? { path: base.path, ...range } : base);
    setBusy(true);
    try {
      const note = await rpc.call("addNote", {
        threadId,
        kind,
        text: noteText,
        groupIndex: payload.groupIndex,
        location,
      });
      setText("");
      setShowMoreKinds(false);
      const locus = [payload.groupIndex === null ? null : `group ${payload.groupIndex + 1}`, formatLocation(note.location)]
        .filter(Boolean)
        .join(", ");
      setFeedback({ tone: "ok", text: `Recorded ${NOTE_KIND_LABEL[kind].toLowerCase()} ${note.id}${locus ? ` · ${locus}` : ""}` });
      inputRef.current?.focus();
    } catch (cause) {
      setFeedback({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  /** Enter: typed commands run, other text is a question, empty continues. */
  const submitText = () => {
    if (trimmed === "") {
      respond(payload.stage === "finish" ? { action: "complete" } : { action: "next" });
      return;
    }
    const intent = parseCommand(trimmed);
    switch (intent.kind) {
      case "navigate":
        respond(payload.stage === "finish" ? { action: "complete" } : { action: intent.action });
        return;
      case "notes":
        setText("");
        openPanel();
        return;
      case "record":
        void record(intent.noteKind, intent.text);
        return;
      case "incomplete":
        setFeedback({ tone: "error", text: `Add text after .${intent.noteKind} to record it.` });
        return;
      case "text":
        respond({ action: "ask", text: intent.text });
        return;
    }
  };

  const suggestionsRef = useRef(payload.suggestions);
  suggestionsRef.current = payload.suggestions;
  const respondRef = useRef(respond);
  respondRef.current = respond;
  useEffect(
    () =>
      host.registerChoiceHandler((index) => {
        const suggestion = suggestionsRef.current[index];
        if (suggestion === undefined) return false;
        respondRef.current({ action: "ask", text: suggestion });
        return true;
      }),
    [host],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submitText();
    }
  };

  const groupLocationLabel = payload.groupIndex === null ? "Whole review" : `Group ${payload.groupIndex + 1}`;

  return (
    <div className="flex flex-col gap-2.5 p-3" aria-busy={busy}>
      {payload.suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Suggested questions">
          {payload.suggestions.map((suggestion, index) => {
            const shortcut = host.shortcuts.get(String(index));
            return (
              <button
                key={suggestion}
                type="button"
                disabled={busy}
                onClick={() => respond({ action: "ask", text: suggestion })}
                aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-left text-xs text-foreground hover:bg-state-hover disabled:opacity-50"
              >
                {shortcut ? <kbd className="font-mono text-[10px] text-muted-foreground">{shortcut.label}</kbd> : null}
                <span className="truncate">{suggestion}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <label htmlFor={inputId} className="sr-only">
        Ask a question or record a note
      </label>
      <textarea
        id={inputId}
        ref={inputRef}
        value={text}
        rows={2}
        disabled={busy}
        onChange={(event) => {
          setText(event.target.value);
          if (feedback?.tone === "error") setFeedback(null);
        }}
        onKeyDown={onKeyDown}
        placeholder={
          payload.stage === "finish"
            ? "Tell the agent what to do next. Done closes the walkthrough."
            : payload.stage === "overview"
              ? "Ask about the overview, or jot a note to record. Enter with nothing typed starts group 1."
              : "Ask about this group, or jot a note to record. Enter with nothing typed continues."
        }
        className="min-h-[3.25rem] w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Record as</span>
        {[...kinds, ...(showMoreKinds ? moreKinds : [])].map((kind) => (
          <Button
            key={kind}
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || trimmed === "" || parseCommand(trimmed).kind !== "text"}
            onClick={() => void record(kind, trimmed)}
          >
            {NOTE_KIND_LABEL[kind]}
          </Button>
        ))}
        {!showMoreKinds && moreKinds.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowMoreKinds(true)} aria-label="More note kinds">
            <Icon name="MoreHorizontal" className="size-3.5" aria-hidden />
          </Button>
        ) : null}
        {payload.locations.length > 0 ? (
          <select
            value={locationIndex}
            onChange={(event) => {
              const index = Number(event.target.value);
              setLocationIndex(index);
              const chosen = payload.locations[index];
              setLines(chosen?.startLine ? `${chosen.startLine}${chosen.endLine && chosen.endLine !== chosen.startLine ? `-${chosen.endLine}` : ""}` : "");
            }}
            aria-label="Attach the note to"
            className="h-8 max-w-[16rem] truncate rounded-md border border-input bg-transparent px-2 text-xs"
          >
            <option value={-1}>{groupLocationLabel}</option>
            {payload.locations.map((location, index) => (
              <option key={`${location.path}:${index}`} value={index}>
                {formatLocation(location)}
              </option>
            ))}
          </select>
        ) : null}
        {locationIndex >= 0 ? (
          <input
            value={lines}
            onChange={(event) => setLines(event.target.value)}
            aria-label="Lines"
            placeholder="lines"
            inputMode="numeric"
            className={cn(
              "h-8 w-24 rounded-md border bg-transparent px-2 text-xs",
              lines.trim() !== "" && parseLineRange(lines) === null ? "border-destructive" : "border-input",
            )}
          />
        ) : null}
      </div>

      <p
        role="status"
        aria-live="polite"
        className={cn("min-h-4 text-xs", feedback?.tone === "error" ? "text-destructive" : "text-muted-foreground")}
      >
        {feedback?.text ?? ""}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={openPanel} aria-label={`Open the Walkthrough panel, ${openNotes} open notes`}>
          <Icon name="ListTodo" className="size-3.5" aria-hidden />
          Notes{openNotes > 0 ? ` (${openNotes})` : ""}
        </Button>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void cancel().catch(() => {})}>
            Use chat
          </Button>
          {payload.stage !== "finish" ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => respond({ action: "finish" })}>
              Finish
            </Button>
          ) : null}
          {trimmed !== "" && parseCommand(trimmed).kind === "text" ? (
            <Button type="button" size="sm" disabled={busy} onClick={submitText}>
              <Icon name="MessageQuestion" className="size-3.5" aria-hidden />
              {payload.stage === "finish" ? "Send" : "Ask"}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => respond(payload.stage === "finish" ? { action: "complete" } : { action: "next" })}
              className="max-w-[18rem]"
            >
              <span className="truncate" title={primaryLabel(payload)}>
                {primaryLabel(payload)}
              </span>
              <Icon name={payload.stage === "finish" ? "Check" : "ArrowRight"} className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
