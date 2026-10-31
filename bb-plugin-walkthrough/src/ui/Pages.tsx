// The pages of the reader: the introduction, one part, the wrap-up, and the
// skeleton shown before anything is written.
import { useContext, useEffect, useState, type ReactNode } from "react";
import { experimental_FileLink as FileLink } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { SavedNotes } from "../save-notes.ts";
import type { Coverage, Place, DeliveredCodeBlock, DeliveredNote as Note, DeliveredPart as Part, DeliveredWalkthrough as Walkthrough, Exchange } from "../schemas.ts";
import { Figure, type FlagTarget } from "./Figure.tsx";
import { countedOpen, openConcerns, PostReviewControl, type ReviewDraftView } from "./Concerns.tsx";
import { filesRead } from "../coverage.ts";
import { partState } from "./fields.ts";
import { unsentItems } from "./hand-off.ts";
import { type WalkthroughRpc } from "./hooks.ts";
import { useFail, useNotify } from "./notices.tsx";
import { stripReplyWrapper } from "./reply.ts";
import { Prose, type ProseContext } from "./prose.tsx";
import { previewFor, partPreview, StreamContext, useStreamedView, type StreamedBlock } from "./stream.ts";

/** The code rows of a skeleton figure: a gutter number and a line of code at an indent, like the rows that will replace them. */
const SKELETON_ROWS: Array<[indent: number, width: number]> = [
  [0, 70],
  [1, 52],
  [1, 64],
  [2, 40],
  [2, 58],
  [1, 30],
  [0, 18],
  [0, 46],
];

/**
 * The layout of a part before it is written: a title, a paragraph, a figure
 * built from the figure's own header and rows (so it has the real width, edge
 * and height), and a closing paragraph. When the part arrives nothing moves.
 */
export function Skeleton({ label }: { label?: string }) {
  const lines = (widths: number[]) => (
    <div className="wt-skel-p">
      {widths.map((width, index) => (
        <span key={index} className="wt-skel" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
  return (
    <div className="wt-skeleton" role="status" aria-label={label ?? "Writing this part"}>
      <span className="wt-skel wt-skel-title" />
      {lines([96, 90, 58])}
      <figure className="wt-figure wt-skel-figure" aria-hidden>
        <div className="wt-cap">
          <span className="wt-skel" style={{ width: "46%", height: 12 }} />
        </div>
        <div className="wt-fig">
          <div className="wt-fh">
            <span className="wt-skel" style={{ width: 132, height: 10 }} />
            <span className="wt-sp" />
            <span className="wt-skel wt-skel-seg" />
          </div>
          <div className="wt-code">
            <div className="wt-code-rows">
              {SKELETON_ROWS.map(([indent, width], index) => (
                <div key={index} className="wt-row wt-skel-row">
                  <b>
                    <span className="wt-skel" style={{ width: 16, height: 8 }} />
                  </b>
                  <span className="wt-skel" style={{ width: `${width}%`, height: 8, marginLeft: indent * 24 }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </figure>
      {lines([92, 44])}
      {/* The pager and the part's own state already say a part is being written; its label stays for assistive technology only. */}
      {label ? <p className={label.startsWith("Writing") ? "wt-sr" : "wt-muted wt-skel-note"}>{label}</p> : null}
    </div>
  );
}

/** Open notes the reader anchored inside one code block of the part on screen. */
function notesInBlock(notes: Note[], partIndex: number | null, block: DeliveredCodeBlock): Note[] {
  return notes.filter((note) => {
    const location = note.location;
    if (note.status !== "open" || note.groupIndex !== partIndex || !location || location.path !== block.path || location.startLine === undefined) return false;
    return location.startLine >= block.startLine && location.startLine <= block.endLine;
  });
}

export function Blocks({
  walkthrough,
  blocks,
  notes,
  partIndex,
  wide,
  onFlag,
}: {
  walkthrough: Walkthrough;
  blocks: StreamedBlock[];
  notes: Note[];
  partIndex: number | null;
  wide: boolean;
  onFlag: (target: FlagTarget, anchor: DOMRect) => void;
}) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "code") return <Figure key={index} walkthrough={walkthrough} block={block} notes={notesInBlock(notes, partIndex, block)} wide={wide} onFlag={onFlag} streaming={block.streaming === true} />;
        const nearest = blocks.slice(index + 1).find((candidate) => candidate.kind === "code") ?? blocks.slice(0, index).reverse().find((candidate) => candidate.kind === "code");
        const context: ProseContext = { files: walkthrough, codePath: nearest?.kind === "code" ? nearest.path : null };
        return <Prose key={index} text={block.text} context={context} className={block.streaming ? "wt-streaming" : undefined} />;
      })}
    </>
  );
}

function Heading({ label, title, placeholder = false }: { label?: string | undefined; title: string; placeholder?: boolean }) {
  return (
    <header className="wt-head">
      {label ? <p className="wt-lbl">{label}</p> : null}
      <h2 data-placeholder={placeholder || undefined}>{title}</h2>
    </header>
  );
}

/** The title the helper has not chosen yet: the request stands in, softly, until the plan names the walkthrough. */
export function pageTitle(walkthrough: Pick<Walkthrough, "title" | "request">): { text: string; placeholder: boolean } {
  if (walkthrough.title !== "Walkthrough") return { text: walkthrough.title, placeholder: false };
  return { text: walkthrough.request.trim() || "Reading your changes…", placeholder: true };
}

/** What the helper has done so far besides writing, said without a forecast: "Looking through the code · 4 steps so far". */
export function workingLine(steps: number | undefined): string | null {
  return steps === undefined || steps <= 0 ? null : `Looking through the code \u00b7 ${steps} ${steps === 1 ? "step" : "steps"} so far`;
}

export function Introduction({ walkthrough, onOpen, streaming = false, coverage, label = "Introduction", subject, working = null }: { walkthrough: Walkthrough; onOpen: (index: number) => void; streaming?: boolean; coverage?: Coverage | null | undefined; label?: string; subject?: ReactNode; /** An honest line about what the helper is doing while it has not written more yet. */ working?: string | null }) {
  const title = pageTitle(walkthrough);
  return (
    <article>
      <Heading label={label} title={title.text} placeholder={title.placeholder} />
      {subject ? <p className="wt-subject">{subject}</p> : null}
      <Prose text={walkthrough.introduction} context={{ files: walkthrough, codePath: null }} className={streaming ? "wt-streaming" : undefined} />
      {working ? (
        <p className="wt-muted wt-pulse" role="status">
          {working}
        </p>
      ) : null}
      {walkthrough.parts.length > 0 ? (
        <ol className="wt-toc" aria-label="Parts">
          {walkthrough.parts.map((part, index) => (
            <li key={`${index}:${part.title}`}>
              <button type="button" onClick={() => onOpen(index)}>
                <span className="wt-toc-n">{index + 1}</span>
                <span>
                  <span className="wt-toc-t">{part.title}</span>
                  {part.summary ? <span className="wt-toc-s">{part.summary}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      <CoverageStrip coverage={coverage} walkthrough={walkthrough} />
    </article>
  );
}

const EXCLUDED_WORD = { lockfile: "lockfile", generated: "generated", binary: "binary" } as const;

/** The files an overview's figures cite: the understand-mode counterpart of the coverage strip. */
function FilesReadStrip({ walkthrough }: { walkthrough: Walkthrough }) {
  const read = filesRead(walkthrough);
  if (read.length === 0) return null;
  return (
    <section className="wt-coverage" aria-label="Files read">
      <p className="wt-coverage-line">
        <strong>Files read</strong>
        <span className="wt-muted"> · {read.length} {read.length === 1 ? "file" : "files"} cited in figures</span>
      </p>
      <ul className="wt-coverage-files" aria-label="Files read">
        {read.map((path) => (
          <li key={path} data-covered="">
            {path}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Which of the changed files the figures cover, so the reader knows what the walkthrough left out. Hidden until the server knows the changed files. */
export function CoverageStrip({ coverage, walkthrough }: { coverage: Coverage | null | undefined; walkthrough?: Walkthrough }) {
  // An overview has no change to measure against, so its strip lists the files its figures drew on.
  if (walkthrough?.intent === "understand") return <FilesReadStrip walkthrough={walkthrough} />;
  if (!coverage || coverage.changed === 0) return null;
  const countable = coverage.files.filter((file) => file.excluded === null);
  const shown = countable.filter((file) => file.covered).length;
  const left = coverage.files.filter((file) => !file.covered && file.excluded === null);
  const quiet = coverage.files.filter((file) => !file.covered && file.excluded !== null);
  const plural = countable.length === 1 ? "file" : "files";
  return (
    <section className="wt-coverage" aria-label="Coverage">
      <p className="wt-coverage-line">
        <strong>
          {shown} of {countable.length}
        </strong>{" "}
        changed {plural} shown in figures
        {left.length === 0 ? <span className="wt-muted"> · every file covered</span> : null}
      </p>
      <ul className="wt-coverage-files" aria-label="Changed files">
        {coverage.files.map((file) => (
          <li key={file.path} data-covered={file.covered || undefined} data-excluded={file.excluded ?? undefined}>
            <span className="wt-sr">{file.covered ? "Covered: " : file.excluded ? `Not shown, ${EXCLUDED_WORD[file.excluded]}: ` : "Not covered: "}</span>
            {file.path}
            {!file.covered && file.excluded ? <span className="wt-muted"> ({EXCLUDED_WORD[file.excluded]})</span> : null}
          </li>
        ))}
        {coverage.truncated ? <li className="wt-muted">and more not listed</li> : null}
      </ul>
      {left.length > 0 ? (
        <p className="wt-muted wt-coverage-left">
          Not covered: {left.map((file) => file.path).join(", ")}
          {quiet.length > 0 ? `. Left out on purpose: ${quiet.map((file) => file.path).join(", ")}` : ""}
        </p>
      ) : null}
    </section>
  );
}

export function PartPage({
  walkthrough,
  index,
  notes,
  rpc,
  wide,
  onFlag,
}: {
  walkthrough: Walkthrough;
  index: number;
  notes: Note[];
  rpc: WalkthroughRpc;
  wide: boolean;
  onFlag: (target: FlagTarget, anchor: DOMRect) => void;
}) {
  const part = walkthrough.parts[index]!;
  const closed = walkthrough.status === "done";
  const fail = useFail();
  const retry = () => void rpc.call("retry", { walkthroughId: walkthrough.id, place: index }).catch(fail);
  const state = partState(walkthrough, part);
  // What the worker has written so far stands in until the part is saved; the saved blocks take over in the same elements.
  const streams = useContext(StreamContext);
  const streamed = useStreamedView(partPreview(streams, walkthrough, index));
  const blocks: StreamedBlock[] = part.blocks.length > 0 ? part.blocks : (streamed?.blocks ?? []);
  return (
    <article aria-busy={part.status === "writing" || undefined}>
      <Heading title={part.title} />
      {state === "stale" ? (
        <div role="status" className="wt-stale">
          <span>
            {(() => {
              const files = (part as { staleFiles?: string[] }).staleFiles ?? [];
              const named = files.slice(0, 2).map((file) => file.split("/").pop()).join(", ");
              return files.length > 0 ? `${named}${files.length > 2 ? ` and ${files.length - 2} more` : ""} changed after this part was written, so details here may be out of date.` : "The code changed after this part was written, so details here may be out of date.";
            })()}
          </span>
          <button type="button" className="wt-btn wt-btn-quiet" onClick={retry}>
            Rewrite this part
          </button>
        </div>
      ) : null}
      {part.status === "ready" || (part.status !== "failed" && blocks.length > 0) ? (
        <>
          <Blocks walkthrough={walkthrough} blocks={blocks} notes={notes} partIndex={index} wide={wide} onFlag={onFlag} />
          {part.status !== "ready" ? <Skeleton label="Writing this part…" /> : null}
        </>
      ) : part.status === "failed" ? (
        <div className="wt-failed">
          {part.message ? <Prose text={part.message} context={{ files: walkthrough, codePath: null }} /> : <p className="wt-muted">This part could not be written.</p>}
          {closed ? null : (
            <button type="button" className="wt-btn wt-btn-quiet" onClick={retry}>
              Try again
            </button>
          )}
        </div>
      ) : closed ? (
        <p className="wt-muted">This part was not written before the walkthrough finished.</p>
      ) : (
        <>
          {part.summary ? <p className="wt-summary">{part.summary}</p> : null}
          <Skeleton label={part.status === "writing" ? "Writing this part…" : "Waiting for the helper to reach this part"} />
        </>
      )}
    </article>
  );
}

/** The answers to questions asked on a page, as a thread hanging under it. */
export function Thread({ walkthrough, part, place }: { walkthrough: Walkthrough; part: Part; place: Place }) {
  if (part.discussion.length === 0) return null;
  return (
    <section className="wt-thread" aria-label="Questions about this part">
      {part.discussion.map((exchange) => (
        <ExchangeView key={exchange.id} walkthrough={walkthrough} exchange={exchange} place={place} />
      ))}
    </section>
  );
}

function ExchangeView({ walkthrough, exchange, place }: { walkthrough: Walkthrough; exchange: Exchange; place: Place }) {
  // The answer streams in through the same channel as parts; the saved answer takes over when the exchange settles.
  const streams = useContext(StreamContext);
  const live = exchange.status === "answering" ? previewFor(streams, walkthrough, "ask", place, exchange.id) : null;
  const answer = stripReplyWrapper(live && live.text.length > exchange.answer.length ? live.text : exchange.answer);
  const streaming = exchange.status === "answering" && answer !== "";
  return (
    <div className="wt-ex" data-status={exchange.status}>
      <p className="wt-q">{exchange.question}</p>
      {answer ? <Prose text={answer} context={{ files: walkthrough, codePath: null }} className={cn("wt-a", streaming && "wt-streaming")} /> : null}
      {exchange.status === "queued" ? <p className="wt-muted">Waiting for the current step to finish…</p> : null}
      {exchange.status === "answering" && !answer ? <p className="wt-muted wt-pulse">Thinking…</p> : null}
      {exchange.status === "failed" ? <p className="wt-muted">No answer came back. Ask again?</p> : null}
    </div>
  );
}

/** The ledger of what the reading left open. Its primary action is pinned in the pager (see WrapUpActions). */
export function WrapUpPage({
  walkthrough,
  notes,
  draft,
  coverage,
  rpc,
  wide,
  onFlag,
  onOpenPart,
  onOpenConcerns,
}: {
  walkthrough: Walkthrough;
  notes: Note[];
  draft: ReviewDraftView | null;
  coverage?: Coverage | null | undefined;
  rpc: WalkthroughRpc;
  wide: boolean;
  onFlag: (target: FlagTarget, anchor: DOMRect) => void;
  onOpenPart: (index: number) => void;
  onOpenConcerns: () => void;
}) {
  const wrap = walkthrough.wrapUp;
  const closed = walkthrough.status === "done";
  const fail = useFail();
  const open = countedOpen(notes);
  const count = (kind: Note["kind"]) => open.filter((note) => note.kind === kind).length;
  const answered = walkthrough.parts.reduce((total, part) => total + part.discussion.filter((exchange) => exchange.status === "done").length, 0) + (wrap?.discussion.filter((exchange) => exchange.status === "done").length ?? 0);
  const skipped = walkthrough.parts.map((part, index) => ({ part, index })).filter(({ part }) => part.status !== "ready");
  const inReview = walkthrough.intent === "review" ? (draft?.comments.length ?? 0) : null;
  const waiting = openConcerns(notes).length - open.length;
  const title = pageTitle(walkthrough);
  const openSummary = [
    count("todo") ? `${count("todo")} to do` : null,
    count("question") ? `${count("question")} ${count("question") === 1 ? "question" : "questions"}` : null,
    count("comment") ? `${count("comment")} ${count("comment") === 1 ? "comment" : "comments"}` : null,
    count("note") ? `${count("note")} ${count("note") === 1 ? "note" : "notes"}` : null,
  ].filter(Boolean);
  return (
    <article aria-busy={wrap?.status === "writing" || undefined}>
      <Heading label={closed ? "Finished" : "Wrap-up"} title={title.text} />
      {wrap?.status === "ready" ? (
        <Blocks walkthrough={walkthrough} blocks={wrap.blocks} notes={notes} partIndex={null} wide={wide} onFlag={onFlag} />
      ) : wrap?.status === "failed" ? (
        <div className="wt-failed">
          {wrap.message ? <Prose text={wrap.message} context={{ files: walkthrough, codePath: null }} /> : null}
          {closed ? null : (
            <button type="button" className="wt-btn wt-btn-quiet" onClick={() => void rpc.call("retry", { walkthroughId: walkthrough.id, place: "wrap-up" }).catch(fail)}>
              Try again
            </button>
          )}
        </div>
      ) : closed ? null : (
        <p className="wt-muted wt-pulse" role="status">
          Going over your notes and answering what it can…
        </p>
      )}
      <dl className="wt-ledger" aria-label="What is left">
        <div>
          <dt>Open items</dt>
          <dd>
            <strong>{open.length}</strong>
            <span>
              open{inReview !== null ? ` · ${inReview} in review` : ""}
              {waiting > 0 ? ` · ${waiting} waiting on the thread` : ""}
            </span>
            {openSummary.length > 0 ? <span className="wt-muted">{openSummary.join(", ")}</span> : null}
            {open.length > 0 ? (
              <button type="button" className="wt-link-btn" onClick={onOpenConcerns}>
                Review them
              </button>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Questions answered</dt>
          <dd>
            <strong>{answered}</strong>
          </dd>
        </div>
        <div>
          <dt>Parts skipped</dt>
          <dd>
            <strong>{skipped.length}</strong>
            {skipped.map(({ part, index }) => (
              <button key={index} type="button" className="wt-link-btn" onClick={() => onOpenPart(index)}>
                {part.title}
              </button>
            ))}
          </dd>
        </div>
      </dl>
      <CoverageStrip coverage={coverage} walkthrough={walkthrough} />
    </article>
  );
}

/**
 * Handing open items to the thread: one flow for every button that does it.
 * The reader sees the exact message first, can edit it, and sends it with an
 * explicit Send; nothing leaves the pane before that.
 */
export function useSendToThread(walkthrough: Walkthrough, rpc: WalkthroughRpc, notify: (message: string, tone?: "success" | "info" | "error") => void, fail: (cause: unknown) => void) {
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState(false);
  const send = async (draft: { message: string; noteIds: string[] }) => {
    setSending(true);
    try {
      const { sent } = await rpc.call("handOff", { walkthroughId: walkthrough.id, ...draft });
      notify(sent ? "Sent to your thread" : "Nothing new to send", sent ? "success" : "info");
      setOpen(false);
    } catch (cause) {
      fail(cause);
    } finally {
      setSending(false);
    }
  };
  const title = walkthrough.intent === "understand" ? "Ask the thread to apply it" : "Send open items to thread";
  // Rendered once, by the reader, wherever the buttons are.
  const dialog = <ApplyDialog open={open} onOpenChange={setOpen} title={title} walkthroughId={walkthrough.id} rpc={rpc} sending={sending} onSend={(draft) => void send(draft)} />;
  return { title, sending, openDialog: () => setOpen(true), dialog };
}

/** What the reader's saved notes were when they were saved, so the button knows when saving again would change something. */
function notesSignature(notes: Note[]): string {
  return notes
    .filter((note) => note.status === "open")
    .map((note) => `${note.id}:${note.updatedAt}`)
    .join("|");
}

/**
 * The wrap-up's primary action, by what the reader came to do. It lives in the
 * pager so it is reachable without scrolling. Handing items to the thread is
 * only enabled while there is something new to hand over, and then reads "Sent".
 */
export function WrapUpActions({ walkthrough, notes, draft, rpc, send }: { walkthrough: Walkthrough; notes: Note[]; draft: ReviewDraftView | null; rpc: WalkthroughRpc; send: ReturnType<typeof useSendToThread> }) {
  const intent = walkthrough.intent;
  const notify = useNotify();
  const fail = useFail();
  const [saved, setSaved] = useState<{ result: SavedNotes; signature: string } | null>(null);
  const unsent = unsentItems(notes).length;
  const sentBefore = notes.some((note) => note.sentAt);
  const signature = notesSignature(notes);
  const openNotes = notes.filter((note) => note.status === "open").length;
  const savedNow = saved !== null && saved.signature === signature;
  const saveNotes = async () => {
    try {
      setSaved({ result: await rpc.call("saveNotes", { walkthroughId: walkthrough.id }), signature });
      notify("Notes saved");
    } catch (cause) {
      fail(cause);
    }
  };
  if (intent === "review") return <PostReviewControl walkthrough={walkthrough} draft={draft} rpc={rpc} />;
  const sentAll = unsent === 0 && sentBefore;
  const sendButton = (primary: boolean) => (
    <button type="button" className={cn("wt-btn", primary ? "wt-btn-primary" : "wt-btn-quiet")} disabled={send.sending || unsent === 0} onClick={send.openDialog} data-sent={sentAll ? "" : undefined}>
      {sentAll ? "Sent to thread" : send.title}
    </button>
  );
  if (intent === "own-change") return sendButton(true);
  return (
    <>
      <button type="button" className={cn("wt-btn", savedNow ? "wt-btn-quiet" : "wt-btn-primary")} disabled={savedNow || openNotes === 0} data-sent={savedNow ? "" : undefined} onClick={() => void saveNotes()}>
        {savedNow ? "Saved" : "Save notes"}
      </button>
      {sendButton(false)}
      {saved ? (
        <span className="wt-muted wt-saved" role="status">
          Saved to this thread&rsquo;s storage:{" "}
          <FileLink target={{ kind: "thread-storage", threadId: saved.result.threadId, path: saved.result.path }} className="wt-loc">
            {saved.result.path.split("/").pop()}
          </FileLink>
        </span>
      ) : null}
    </>
  );
}

/** The message "Ask the thread to apply it" will send, as the plugin prepared it: editable, and sent only when the reader presses Send. */
function ApplyDialog({
  open,
  onOpenChange,
  title,
  walkthroughId,
  rpc,
  sending,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  walkthroughId: string;
  rpc: WalkthroughRpc;
  sending: boolean;
  onSend: (draft: { message: string; noteIds: string[] }) => void;
}) {
  const fail = useFail();
  // undefined while preparing; null when nothing is waiting.
  const [prepared, setPrepared] = useState<{ message: string; noteIds: string[] } | null | undefined>(undefined);
  const [edited, setEdited] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPrepared(undefined);
    setEdited(null);
    rpc.call("prepareHandOff", { walkthroughId }).then(
      (result) => live && setPrepared(result.draft),
      (cause: unknown) => {
        if (!live) return;
        setPrepared(null);
        fail(cause);
      },
    );
    return () => {
      live = false;
    };
  }, [open, rpc, walkthroughId, fail]);
  const text = edited ?? prepared?.message ?? "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="wt-portal wt-dialog wt-apply">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>This is the message your thread will receive. Edit it, then send it. Nothing is sent until you press Send.</DialogDescription>
        </DialogHeader>
        <textarea
          className="wt-apply-text"
          aria-label="Message to your thread"
          rows={10}
          value={text}
          disabled={prepared === undefined || prepared === null}
          placeholder={prepared === undefined ? "Preparing the message…" : "Nothing is waiting to be sent."}
          onChange={(event) => setEdited(event.target.value)}
        />
        <DialogFooter className="wt-dialog-actions">
          <Button type="button" variant="ghost" className="wt-btn wt-btn-quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" className="wt-btn wt-btn-primary" disabled={sending || !prepared || text.trim() === ""} onClick={() => prepared && onSend({ message: text, noteIds: prepared.noteIds })}>
            Send to thread
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
