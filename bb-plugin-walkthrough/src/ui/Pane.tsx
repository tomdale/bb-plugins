// The Walkthrough pane: a reading view that opens beside the user's thread.
// A contents rail, one part at a time in a serif reading column, a
// conversation under each part, and a drawer for notes and the review draft.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useBbNavigate, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { NOTE_KIND_LABEL, parseCommand, shortRef } from "../model.ts";
import { PANEL_ACTION_ID, type Block, type NoteKind, type Exchange, type Part, type Place, type Walkthrough, type WalkthroughView } from "../schemas.ts";
import { CodeExcerpt } from "./code.tsx";
import { errorMessage, useThreadWalkthroughs, useWalkthrough, useWidth, type WalkthroughRpc } from "./hooks.ts";
import { openPane, StartForm } from "./Starter.tsx";
import { NotesTab, ReviewTab, type NoteDraft } from "./notes.tsx";
import { Muted } from "./parts.tsx";
import { Prose, type ProseContext } from "./prose.tsx";

export function paneParams(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const id = (params as Record<string, unknown>).walkthroughId;
  return typeof id === "string" ? id : null;
}

export function WalkthroughPane({ threadId, params }: PluginThreadPanelProps) {
  const walkthroughId = paneParams(params);
  const { view, loaded, error, rpc } = useWalkthrough(walkthroughId);
  if (walkthroughId === null) return <EmptyPane threadId={threadId} />;
  if (!loaded) return <Muted className="p-6">{error ?? "Opening the walkthrough…"}</Muted>;
  if (view === null) return <Muted className="p-6">This walkthrough no longer exists.</Muted>;
  return <Reader threadId={threadId} view={view} rpc={rpc} />;
}

/** A pane opened from the side panel's launcher: earlier walkthroughs plus a starter. */
function EmptyPane({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const { walkthroughs } = useThreadWalkthroughs(threadId);
  return (
    <div className="mx-auto w-full max-w-[40rem] space-y-6 px-6 py-8">
      <div>
        <h2 className="font-serif text-2xl font-medium">Start a walkthrough</h2>
        <p className="mt-1 text-sm text-muted-foreground">A helper agent that knows this conversation explains the change here, part by part. This thread keeps working as usual.</p>
      </div>
      <StartForm threadId={threadId} autoFocus />
      {walkthroughs.length > 0 ? (
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Earlier walkthroughs in this thread</p>
          <ul className="space-y-1">
            {walkthroughs.map((walkthrough) => (
              <li key={walkthrough.id}>
                <button type="button" onClick={() => openPane(navigate, walkthrough.id, walkthrough.title)} className="text-left text-sm hover:underline">
                  {walkthrough.title === "Walkthrough" ? walkthrough.request : walkthrough.title}
                  <span className="ml-2 text-xs text-muted-foreground">{walkthrough.status === "done" ? "finished" : walkthrough.status}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

type Drawer = "notes" | "review" | null;

function progress(walkthrough: Walkthrough): string {
  if (walkthrough.status === "planning") return "Getting ready";
  if (walkthrough.status === "wrapping-up") return "Wrapping up";
  if (walkthrough.status === "done") return "Finished";
  if (walkthrough.status === "failed") return "Stopped";
  if (walkthrough.currentPart === null) return "Introduction";
  return `Part ${walkthrough.currentPart + 1} of ${walkthrough.parts.length}`;
}

function activity(walkthrough: Walkthrough): string | null {
  const request = walkthrough.inFlight?.request;
  if (!request) return walkthrough.queue.length > 0 ? "Waiting to continue…" : null;
  switch (request.kind) {
    case "plan":
      return "Reading the change…";
    case "write": {
      const part = walkthrough.parts[request.part];
      if (walkthrough.currentPart === request.part) return "Writing this part…";
      return part ? `Getting “${part.title}” ready…` : "Writing…";
    }
    case "ask":
      return "Answering…";
    case "reply":
      return "Thinking…";
    case "wrap-up":
      return "Wrapping up…";
  }
}

function Reader({ threadId, view, rpc }: { threadId: string; view: WalkthroughView; rpc: WalkthroughRpc }) {
  const { walkthrough, notes } = view;
  const navigate = useBbNavigate();
  const [rootRef, width] = useWidth<HTMLDivElement>();
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const wide = width >= 900;
  const showRail = width >= 700;
  const openNotes = notes.filter((note) => note.status === "open").length;

  // Keep the tab title in step with the walkthrough once it has one.
  const titled = useRef<string | null>(null);
  useEffect(() => {
    if (walkthrough.title === "Walkthrough" || titled.current === walkthrough.title) return;
    titled.current = walkthrough.title;
    navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: walkthrough.title, params: { walkthroughId: walkthrough.id } });
  }, [navigate, walkthrough.id, walkthrough.title]);

  const call = useCallback(
    (run: () => Promise<unknown>) => {
      run().catch((cause: unknown) => toast.error(errorMessage(cause)));
    },
    [],
  );
  const openPart = (index: number | null) => call(() => rpc.call("openPart", { walkthroughId: walkthrough.id, index }));
  const noteFromSelection = (quote: string) => {
    setDraft({ quote, groupIndex: walkthrough.currentPart, sequence: Date.now() });
    setDrawer("notes");
  };

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Icon name="Explore" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{walkthrough.title}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {progress(walkthrough)}
            {walkthrough.parts.length > 0 ? ` · ${walkthrough.mode === "pr" && walkthrough.pr ? `PR #${walkthrough.pr.number}` : "your changes"} compared with ${shortRef(walkthrough.baseRef)}` : ""}
            {activity(walkthrough) ? <span className="ml-2 animate-pulse">{activity(walkthrough)}</span> : null}
          </p>
        </div>
        <Button type="button" variant={drawer === "notes" ? "secondary" : "ghost"} size="sm" onClick={() => setDrawer(drawer === "notes" ? null : "notes")}>
          <Icon name="ListTodo" className="size-3.5" aria-hidden />
          {openNotes === 0 ? "Notes" : openNotes === 1 ? "1 note" : `${openNotes} notes`}
        </Button>
        {walkthrough.mode === "pr" ? (
          <Button type="button" variant={drawer === "review" ? "secondary" : "ghost"} size="sm" onClick={() => setDrawer(drawer === "review" ? null : "review")}>
            <Icon name="GitPullRequest" className="size-3.5" aria-hidden />
            Review
          </Button>
        ) : null}
        {walkthrough.status !== "done" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Close this walkthrough"
            onClick={() => call(() => rpc.call("close", { walkthroughId: walkthrough.id }))}
          >
            <Icon name="X" className="size-3.5" aria-hidden />
          </Button>
        ) : null}
      </header>

      <div className="relative flex min-h-0 flex-1">
        {showRail && walkthrough.parts.length > 0 ? <Contents walkthrough={walkthrough} onOpen={openPart} /> : null}
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Page walkthrough={walkthrough} rpc={rpc} wide={wide} onOpen={openPart} onNote={noteFromSelection} threadId={threadId} showContents={!showRail} />
        </main>
        {drawer ? (
          <aside className={cn("min-h-0 overflow-y-auto border-l border-border bg-card p-3", wide ? "w-80 shrink-0" : "absolute inset-y-0 right-0 z-10 w-[min(22rem,100%)] shadow-sm")}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-medium text-muted-foreground">{drawer === "notes" ? "Notes" : "Review draft"}</h2>
              <button type="button" aria-label="Close" onClick={() => setDrawer(null)} className="rounded p-1 text-muted-foreground hover:text-foreground">
                <Icon name="X" className="size-3.5" aria-hidden />
              </button>
            </div>
            {drawer === "notes" ? (
              <NotesTab view={view} rpc={rpc} draft={draft} onDraftUsed={() => setDraft(null)} />
            ) : (
              <ReviewTab walkthrough={walkthrough} rpc={rpc} />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function Contents({ walkthrough, onOpen }: { walkthrough: Walkthrough; onOpen: (index: number | null) => void }) {
  return (
    <nav aria-label="In this walkthrough" className="w-44 shrink-0 overflow-y-auto border-r border-border px-3 py-4 text-[12.5px]">
      <p className="mb-2 text-xs text-muted-foreground">In this walkthrough</p>
      <ol className="space-y-1">
        <li>
          <button
            type="button"
            onClick={() => onOpen(null)}
            aria-current={walkthrough.currentPart === null && walkthrough.status === "reading" ? "page" : undefined}
            className={cn("w-full text-left leading-snug hover:text-foreground", walkthrough.currentPart === null ? "text-foreground" : "text-muted-foreground")}
          >
            Introduction
          </button>
        </li>
        {walkthrough.parts.map((part, index) => {
          const current = walkthrough.currentPart === index && walkthrough.status !== "wrapping-up";
          return (
            <li key={`${index}:${part.title}`}>
              <button
                type="button"
                onClick={() => onOpen(index)}
                aria-current={current ? "page" : undefined}
                className={cn("flex w-full gap-1.5 text-left leading-snug hover:text-foreground", current ? "text-foreground" : "text-muted-foreground")}
              >
                <span className="w-3 shrink-0">{part.status === "ready" && part.discussion.length > 0 ? "·" : ""}</span>
                <span className="min-w-0 flex-1">{part.title}</span>
              </button>
            </li>
          );
        })}
        {walkthrough.wrapUp ? <li className={cn("pl-[18px]", walkthrough.status !== "reading" ? "text-foreground" : "text-muted-foreground")}>Wrapping up</li> : null}
      </ol>
      {nextReadyHint(walkthrough)}
    </nav>
  );
}

function nextReadyHint(walkthrough: Walkthrough) {
  const next = walkthrough.currentPart === null ? 0 : walkthrough.currentPart + 1;
  const part = walkthrough.parts[next];
  if (!part || walkthrough.status !== "reading") return null;
  return <p className="mt-4 text-[11px] text-muted-foreground">{part.status === "ready" ? "The next part is ready." : part.status === "writing" ? "Writing the next part…" : null}</p>;
}

function Page({
  walkthrough,
  rpc,
  wide,
  onOpen,
  onNote,
  threadId,
  showContents,
}: {
  walkthrough: Walkthrough;
  rpc: WalkthroughRpc;
  wide: boolean;
  onOpen: (index: number | null) => void;
  onNote: (quote: string) => void;
  threadId: string;
  showContents: boolean;
}) {
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const onMouseUp = (event: MouseEvent) => {
    // The note button's own mouseup must not dismiss it before its click lands.
    if ((event.target as HTMLElement).closest("[data-note-from-selection]")) return;
    const text = window.getSelection()?.toString().trim() ?? "";
    const page = pageRef.current;
    if (!page || text.length < 3 || (event.target as HTMLElement).closest("button,textarea,input")) {
      setSelection(null);
      return;
    }
    const range = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    const box = page.getBoundingClientRect();
    setSelection({ text: text.slice(0, 2000), top: range.bottom - box.top + 6, left: Math.max(0, range.left - box.left) });
  };

  let content;
  if (walkthrough.status === "planning" || (walkthrough.status === "failed" && walkthrough.parts.length === 0)) {
    content = <Preparing walkthrough={walkthrough} rpc={rpc} />;
  } else if (walkthrough.status === "wrapping-up" || (walkthrough.status === "done" && walkthrough.wrapUp)) {
    content = <WrapUp walkthrough={walkthrough} rpc={rpc} wide={wide} threadId={threadId} />;
  } else if (walkthrough.currentPart === null) {
    content = <Introduction walkthrough={walkthrough} onOpen={onOpen} />;
  } else {
    content = <PartPage walkthrough={walkthrough} index={walkthrough.currentPart} rpc={rpc} wide={wide} onOpen={onOpen} showContents={showContents} />;
  }
  return (
    <div ref={pageRef} onMouseUp={onMouseUp} className="relative mx-auto w-full max-w-[44rem] px-6 pb-16 pt-8">
      {content}
      {selection ? (
        <button
          type="button"
          data-note-from-selection=""
          style={{ top: selection.top, left: selection.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onNote(selection.text);
            setSelection(null);
            window.getSelection()?.removeAllRanges();
          }}
          className="absolute z-10 rounded-md border border-border bg-card px-2 py-1 text-xs shadow-sm hover:bg-secondary"
        >
          <Icon name="ListTodo" className="mr-1 inline size-3" aria-hidden />
          Leave a note
        </button>
      ) : null}
    </div>
  );
}

function Preparing({ walkthrough, rpc }: { walkthrough: Walkthrough; rpc: WalkthroughRpc }) {
  const waiting = walkthrough.inFlight !== null;
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">You asked</p>
      <p className="font-serif text-lg leading-snug">“{walkthrough.request}”</p>
      {walkthrough.message && !waiting ? (
        <div className="space-y-3 rounded-md border border-border p-3">
          <Prose text={walkthrough.message} context={{ environmentId: walkthrough.environmentId, codePath: null }} />
          {walkthrough.status !== "failed" ? (
            <AskBox placeholder="Reply…" onSubmit={(text) => rpc.call("reply", { walkthroughId: walkthrough.id, text })} />
          ) : null}
        </div>
      ) : (
        <p className="animate-pulse font-serif text-[15px] text-muted-foreground">Reading the change and deciding how to explain it. This takes a minute or so.</p>
      )}
    </div>
  );
}

function Introduction({ walkthrough, onOpen }: { walkthrough: Walkthrough; onOpen: (index: number | null) => void }) {
  return (
    <article className="space-y-6">
      <header>
        <p className="text-xs text-muted-foreground">Introduction</p>
        <h2 className="font-serif text-2xl font-medium leading-tight">{walkthrough.title}</h2>
      </header>
      <Prose text={walkthrough.introduction} context={{ environmentId: walkthrough.environmentId, codePath: null }} />
      <div>
        <p className="mb-2 text-xs text-muted-foreground">
          {walkthrough.parts.length === 1 ? "We’ll go through it in one part" : `We’ll go through it in ${walkthrough.parts.length} parts`}
        </p>
        <ol className="space-y-2">
          {walkthrough.parts.map((part, index) => (
            <li key={`${index}:${part.title}`}>
              <button type="button" onClick={() => onOpen(index)} className="group w-full text-left">
                <span className="font-serif text-[15px] group-hover:underline">{part.title}</span>
                {part.summary ? <span className="block text-[13px] leading-snug text-muted-foreground">{part.summary}</span> : null}
              </button>
            </li>
          ))}
        </ol>
      </div>
      <div className="flex justify-end">
        <Button type="button" onClick={() => onOpen(0)}>
          Start reading
          <Icon name="ArrowRight" className="size-3.5" aria-hidden />
        </Button>
      </div>
    </article>
  );
}

function Blocks({ walkthrough, blocks, wide }: { walkthrough: Walkthrough; blocks: Block[]; wide: boolean }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "code") return <CodeExcerpt key={index} walkthrough={walkthrough} block={block} wide={wide} />;
        const next = blocks.slice(index + 1).find((candidate) => candidate.kind === "code");
        const previous = blocks.slice(0, index).reverse().find((candidate) => candidate.kind === "code");
        const context: ProseContext = {
          environmentId: walkthrough.environmentId,
          codePath: next?.kind === "code" ? next.path : previous?.kind === "code" ? previous.path : null,
        };
        return <Prose key={index} text={block.text} context={context} className="my-3" />;
      })}
    </>
  );
}

function PartPage({
  walkthrough,
  index,
  rpc,
  wide,
  onOpen,
  showContents,
}: {
  walkthrough: Walkthrough;
  index: number;
  rpc: WalkthroughRpc;
  wide: boolean;
  onOpen: (index: number | null) => void;
  showContents: boolean;
}) {
  const part = walkthrough.parts[index]!;
  const next = walkthrough.parts[index + 1];
  const closed = walkthrough.status === "done";
  return (
    <article>
      <header className="mb-4">
        <p className="text-xs text-muted-foreground">
          Part {index + 1} of {walkthrough.parts.length}
        </p>
        <h2 className="font-serif text-2xl font-medium leading-tight">{part.title}</h2>
      </header>
      {part.status === "ready" ? (
        <Blocks walkthrough={walkthrough} blocks={part.blocks} wide={wide} />
      ) : part.status === "failed" ? (
        <div className="space-y-3">
          {part.message ? <Prose text={part.message} context={{ environmentId: walkthrough.environmentId, codePath: null }} /> : null}
          <Button type="button" variant="outline" size="sm" onClick={() => void rpc.call("retry", { walkthroughId: walkthrough.id, place: index }).catch((cause: unknown) => toast.error(errorMessage(cause)))}>
            Try again
          </Button>
        </div>
      ) : (
        <p className="animate-pulse font-serif text-[15px] text-muted-foreground">
          {part.summary ? `${part.summary} ` : ""}Writing this part…
        </p>
      )}

      {part.status === "ready" ? <Discussion walkthrough={walkthrough} place={index} part={part} rpc={rpc} closed={closed} /> : null}

      <footer className="mt-10 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button type="button" variant="ghost" size="sm" onClick={() => onOpen(index === 0 ? null : index - 1)}>
          <Icon name="ArrowLeft" className="size-3.5" aria-hidden />
          {index === 0 ? "Introduction" : walkthrough.parts[index - 1]!.title}
        </Button>
        <span className="flex items-center gap-2">
          {!closed && walkthrough.status === "reading" && next ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void rpc.call("wrapUp", { walkthroughId: walkthrough.id }).catch((cause: unknown) => toast.error(errorMessage(cause)))}>
              Wrap up
            </Button>
          ) : null}
          {next ? (
            <Button type="button" size="sm" onClick={() => onOpen(index + 1)} className="max-w-[20rem]">
              <span className="truncate">Next: {next.title}</span>
              <Icon name="ArrowRight" className="size-3.5" aria-hidden />
            </Button>
          ) : !closed && walkthrough.status === "reading" ? (
            <Button type="button" size="sm" onClick={() => void rpc.call("wrapUp", { walkthroughId: walkthrough.id }).catch((cause: unknown) => toast.error(errorMessage(cause)))}>
              Finish and wrap up
              <Icon name="ArrowRight" className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </span>
      </footer>
      {showContents ? <p className="mt-2 text-center text-[11px] text-muted-foreground">Widen or maximize the pane to see the contents alongside.</p> : null}
    </article>
  );
}

function Discussion({ walkthrough, place, part, rpc, closed }: { walkthrough: Walkthrough; place: Place; part: Part; rpc: WalkthroughRpc; closed: boolean }) {
  const asked = new Set(part.discussion.map((exchange) => exchange.question));
  const suggestions = part.suggestions.filter((suggestion) => !asked.has(suggestion));
  const busy = part.discussion.some((exchange) => exchange.status === "queued" || exchange.status === "answering");
  const ask = (question: string) => rpc.call("ask", { walkthroughId: walkthrough.id, place, question });
  const record = async (kind: NoteKind, text: string) => {
    const note = await rpc.call("addNote", { walkthroughId: walkthrough.id, kind, text, groupIndex: typeof place === "number" ? place : null });
    toast.success(`Saved ${NOTE_KIND_LABEL[note.kind].toLowerCase()} ${note.id}`);
  };
  return (
    closed && part.discussion.length === 0 ? null : <section aria-label="Questions about this part" className="mt-10 border-t border-border pt-5">
      <h3 className="mb-3 text-xs font-medium text-muted-foreground">{place === "wrap-up" ? "Anything else?" : "Questions about this part"}</h3>
      <div className="space-y-5">
        {part.discussion.map((exchange) => (
          <ExchangeView key={exchange.id} walkthrough={walkthrough} exchange={exchange} />
        ))}
      </div>
      {!closed ? (
        <>
          {suggestions.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={busy}
                  onClick={() => void ask(suggestion).catch((cause: unknown) => toast.error(errorMessage(cause)))}
                  className="rounded-full border border-border px-3 py-1 text-left text-xs hover:bg-secondary disabled:opacity-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}
          <AskBox
            className="mt-3"
            placeholder={place === "wrap-up" ? "Ask anything, or tell the agent what to do next…" : "Ask anything about this part…"}
            onSubmit={async (text) => {
              const intent = parseCommand(text);
              if (intent.kind === "record") return record(intent.noteKind, intent.text);
              if (intent.kind === "incomplete") throw new Error(`Add text after .${intent.noteKind} to save it.`);
              return ask(intent.text);
            }}
          />
        </>
      ) : null}
    </section>
  );
}

function ExchangeView({ walkthrough, exchange }: { walkthrough: Walkthrough; exchange: Exchange }) {
  return (
    <div>
      <p className="font-serif italic">“{exchange.question}”</p>
      {exchange.answer ? (
        <Prose text={exchange.answer} context={{ environmentId: walkthrough.environmentId, codePath: null }} className="mt-2" />
      ) : null}
      {exchange.status === "queued" ? <p className="mt-1 text-xs text-muted-foreground">Waiting for the current step to finish…</p> : null}
      {exchange.status === "answering" && !exchange.answer ? <p className="mt-1 animate-pulse text-xs text-muted-foreground">Thinking…</p> : null}
      {exchange.status === "answering" && exchange.answer ? <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-muted-foreground align-middle" /> : null}
      {exchange.status === "failed" ? <p className="mt-1 text-xs text-destructive">No answer came back. Ask again?</p> : null}
    </div>
  );
}

function AskBox({ onSubmit, placeholder, className }: { onSubmit: (text: string) => Promise<unknown>; placeholder: string; className?: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onSubmit(value);
      setText("");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };
  return (
    <div className={cn("flex items-end gap-2", className)}>
      <textarea
        value={text}
        rows={2}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-h-[2.75rem] flex-1 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <Button type="button" size="sm" disabled={busy || !text.trim()} onClick={() => void submit()}>
        Ask
      </Button>
    </div>
  );
}

function WrapUp({ walkthrough, rpc, wide, threadId }: { walkthrough: Walkthrough; rpc: WalkthroughRpc; wide: boolean; threadId: string }) {
  const part = walkthrough.wrapUp;
  const closed = walkthrough.status === "done";
  const [sending, setSending] = useState(false);
  if (part === null) return null;
  const handOff = async () => {
    setSending(true);
    try {
      const { sent } = await rpc.call("handOff", { walkthroughId: walkthrough.id });
      toast[sent ? "success" : "info"](sent ? "Sent the open notes to your thread." : "There are no open todos or questions to send.");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSending(false);
    }
  };
  void threadId;
  return (
    <article>
      <header className="mb-4">
        <p className="text-xs text-muted-foreground">{closed ? "Finished" : "Wrapping up"}</p>
        <h2 className="font-serif text-2xl font-medium leading-tight">{walkthrough.title}</h2>
      </header>
      {part.status === "ready" ? (
        <Blocks walkthrough={walkthrough} blocks={part.blocks} wide={wide} />
      ) : part.status === "failed" ? (
        <div className="space-y-3">
          {part.message ? <Prose text={part.message} context={{ environmentId: walkthrough.environmentId, codePath: null }} /> : null}
          <Button type="button" variant="outline" size="sm" onClick={() => void rpc.call("retry", { walkthroughId: walkthrough.id, place: "wrap-up" })}>
            Try again
          </Button>
        </div>
      ) : (
        <p className="animate-pulse font-serif text-[15px] text-muted-foreground">Going over your notes and answering what it can…</p>
      )}
      {part.status === "ready" ? <Discussion walkthrough={walkthrough} place="wrap-up" part={part} rpc={rpc} closed={closed} /> : null}
      <footer className="mt-10 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" size="sm" disabled={sending} onClick={() => void handOff()}>
          <Icon name="Sent" className="size-3.5" aria-hidden />
          Send open notes to my thread
        </Button>
        {!closed ? (
          <Button type="button" size="sm" onClick={() => void rpc.call("close", { walkthroughId: walkthrough.id })}>
            Done
            <Icon name="Check" className="size-3.5" aria-hidden />
          </Button>
        ) : null}
      </footer>
    </article>
  );
}
