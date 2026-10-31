// The concerns sheet: everything the reader flagged (notes, todos, comments,
// questions) in one list, plus the review draft for a PR. It overlays the page
// from the right and never reflows it.
import { useContext, useMemo, useState, type MutableRefObject } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatLocation, NOTE_KIND_LABEL, noteKindsFor } from "../model.ts";
import type { DeliveredNote as Note, DeliveredWalkthrough as Walkthrough, NoteKind, ReviewEvent, WalkthroughView } from "../schemas.ts";
import { shortPath } from "./fields.ts";
import { unsentItems } from "./hand-off.ts";
import { ellipsize } from "./highlight.ts";
import { Hint } from "./Hint.tsx";
import { InlineCode } from "./inline.tsx";
import { type WalkthroughRpc } from "./hooks.ts";
import { useFail, useNotify } from "./notices.tsx";
import { ReaderContext } from "./context.ts";
import { LocationLink } from "./parts.tsx";

export type ConcernsTab = "open" | "review";

export const KIND_WORD: Record<NoteKind, string> = { question: "Ask", todo: "Todo", comment: "Comment", note: "Note" };

/** Whether this walkthrough has a review to draft. */
export function hasReview(walkthrough: Walkthrough): boolean {
  return walkthrough.mode === "pr" || walkthrough.intent === "review";
}

/** Open notes in reading order: whole-walkthrough notes first, then by part, then oldest first. */
export function openConcerns(notes: Note[]): Note[] {
  return notes
    .filter((note) => note.status === "open")
    .sort((a, b) => (a.groupIndex ?? -1) - (b.groupIndex ?? -1) || a.createdAt - b.createdAt);
}

/** Open notes that still need the reader: todos and questions already handed to the thread are waiting on it, not on them. */
export function countedOpen(notes: Note[]): Note[] {
  return openConcerns(notes).filter((note) => !note.sentAt);
}

/** The review as the pane shows it: the worker's draft merged with the comments the reader included (see `reviewDraft` on the view). */
export type ReviewDraftView = NonNullable<WalkthroughView["reviewDraft"]>;
type DraftComment = ReviewDraftView["comments"][number];

const EVENT_LABEL: Record<ReviewEvent, string> = { COMMENT: "Comment", REQUEST_CHANGES: "Request changes", APPROVE: "Approve" };
/** The dialog title's ending, in a sentence of its own: the event as a label would read as a proper noun. */
const POST_AS: Record<ReviewEvent, string> = { COMMENT: "as a comment", REQUEST_CHANGES: "and request changes", APPROVE: "and approve" };

/** "owner/repo#12" for a GitHub pull request URL; the URL itself for anything else. */
export function prLabel(url: string, number: number): string {
  const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\//u.exec(url);
  return match ? `${match[1]}#${number}` : url;
}

export function ConcernsSheet({
  view,
  rpc,
  open,
  tab,
  onTab,
  onClose,
  onJump,
  sheetRef,
  send,
  pinnedSend,
}: {
  view: WalkthroughView;
  rpc: WalkthroughRpc;
  open: boolean;
  tab: ConcernsTab;
  onTab: (tab: ConcernsTab) => void;
  onClose: () => void;
  onJump: (note: Note) => void;
  sheetRef: MutableRefObject<HTMLElement | null>;
  /** The reader's one flow for handing items to the thread (a previewed, editable message). */
  send: { title: string; sending: boolean; openDialog: () => void };
  /** The same action is already pinned above the composer (the wrap-up), so the sheet does not repeat it. */
  pinnedSend: boolean;
}) {
  const { walkthrough, notes } = view;
  const reviewable = hasReview(walkthrough);
  const openItems = useMemo(() => openConcerns(notes), [notes]);
  const resolved = notes.filter((note) => note.status === "resolved");
  const [showResolved, setShowResolved] = useState(false);
  const comments = view.reviewDraft?.comments ?? [];
  const activeTab = reviewable ? tab : "open";
  const unsent = unsentItems(notes).length;
  const sentBefore = notes.some((note) => note.sentAt);
  // Handing items to the thread only means something when there are todos or questions to hand over.
  const offerSend = !pinnedSend && (unsent > 0 || sentBefore);
  return (
    <aside
      ref={sheetRef}
      id="walkthrough-concerns"
      role="complementary"
      aria-label="Concerns"
      className="wt-sheet wt-glass"
      data-open={open || undefined}
      // A closed sheet is out of the tab order and the accessibility tree.
      inert={!open}
    >
      <div className="wt-tabs" role="tablist" aria-label="Concerns">
        <button type="button" role="tab" aria-selected={activeTab === "open"} onClick={() => onTab("open")}>
          Open items · {countedOpen(notes).length}
        </button>
        {reviewable ? (
          <button type="button" role="tab" aria-selected={activeTab === "review"} onClick={() => onTab("review")}>
            Review draft · {comments.length}
          </button>
        ) : null}
        <span className="wt-sp" />
        <Hint label="Close (Esc)">
          <button type="button" className="wt-icon-btn" aria-label="Close concerns" onClick={onClose}>
            <Icon name="X" className="size-3.5" aria-hidden />
          </button>
        </Hint>
      </div>
      {activeTab === "open" ? (
        <>
          <div className="wt-sheet-body" role="tabpanel" aria-label="Open items">
            {openItems.length === 0 ? <p className="wt-muted">Nothing flagged yet. Select text or a line of code to flag it.</p> : null}
            {reviewable && openItems.some((note) => note.kind !== "question") ? (
              // The same number as the Review draft tab and the wrap-up: what the review will contain right now.
              <p className="wt-review-count" role="status" data-testid="wt-review-count">
                {comments.length === 0 ? "Nothing in the review yet" : `${comments.length} in the review`}
              </p>
            ) : null}
            <ul className="wt-items">
              {openItems.map((note) => (
                <ConcernItem key={note.id} walkthrough={walkthrough} note={note} rpc={rpc} onJump={onJump} />
              ))}
            </ul>
            {resolved.length > 0 ? (
              <>
                <button type="button" className="wt-link-btn" aria-expanded={showResolved} onClick={() => setShowResolved(!showResolved)}>
                  Resolved · {resolved.length}
                </button>
                {showResolved ? (
                  <ul className="wt-items">
                    {resolved.map((note) => (
                      <ConcernItem key={note.id} walkthrough={walkthrough} note={note} rpc={rpc} onJump={onJump} />
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </div>
          {offerSend ? (
            <div className="wt-sheet-foot">
              <button type="button" className="wt-btn wt-btn-quiet" disabled={send.sending || unsent === 0} onClick={send.openDialog}>
                {unsent === 0 ? "Sent to thread" : send.title}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <ReviewDraft walkthrough={walkthrough} draft={view.reviewDraft} rpc={rpc} />
      )}
    </aside>
  );
}

function ConcernItem({ walkthrough, note, rpc, onJump }: { walkthrough: Walkthrough; note: Note; rpc: WalkthroughRpc; onJump: (note: Note) => void }) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [text, setText] = useState(note.text);
  const [answer, setAnswer] = useState(note.resolution ?? "");
  const [kind, setKind] = useState<NoteKind>(note.kind);
  const fail = useFail();
  const { glyphs } = useContext(ReaderContext);
  const update = (patch: Record<string, unknown>) => rpc.call("updateNote", { walkthroughId: walkthrough.id, noteId: note.id, ...patch } as never).catch(fail);
  const remove = () => rpc.call("deleteNote", { walkthroughId: walkthrough.id, noteId: note.id }).catch(fail);
  const part = note.groupIndex === null ? null : walkthrough.parts[note.groupIndex];
  const where = [part ? `Part ${(note.groupIndex ?? 0) + 1}` : null, note.location ? formatLocation({ ...note.location, path: shortPath(note.location.path) }) : null].filter(Boolean).join(" · ");
  const reviewable = hasReview(walkthrough) && note.status === "open" && (note.kind === "comment" || note.kind === "note" || note.kind === "todo");
  const included = note.includeInReview;
  const glyph = glyphs.get(note.id);
  const jump = () => onJump(note);
  return (
    <li className={cn("wt-it", note.status === "resolved" && "wt-it-done", reviewable && !included && "wt-it-excluded")} data-note-id={note.id} data-in-review={reviewable ? String(included) : undefined}>
      {editing ? (
        <form
          className="wt-edit"
          onSubmit={(event) => {
            event.preventDefault();
            void update({ text: text.trim() || note.text, resolution: answer.trim() || null, ...(kind === note.kind ? {} : { kind }) }).then(() => setEditing(false));
          }}
        >
          <div role="radiogroup" aria-label="Kind" className="wt-radios">
            {noteKindsFor(walkthrough.mode).map((candidate) => (
              <button key={candidate} type="button" role="radio" aria-checked={kind === candidate} onClick={() => setKind(candidate)}>
                {KIND_WORD[candidate]}
              </button>
            ))}
          </div>
          <textarea value={text} rows={2} aria-label="Text" onChange={(event) => setText(event.target.value)} />
          <textarea value={answer} rows={1} aria-label="Answer" placeholder="Answer or outcome" onChange={(event) => setAnswer(event.target.value)} />
          <div className="wt-flag-actions">
            <button type="button" className="wt-btn wt-btn-quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="wt-btn wt-btn-primary">
              Save
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="wt-it-head">
            {glyph ? (
              <span className="wt-m wt-m-own wt-m-inline" aria-hidden>
                {glyph}
              </span>
            ) : null}
            <span className="wt-kind">{KIND_WORD[note.kind]}</span>
            {note.author === "agent" ? <span className="wt-kind">· agent</span> : null}
            {note.sentAt ? <span className="wt-kind">· sent</span> : null}
            <span className="wt-sp" />
            {reviewable ? (
              <label className="wt-include">
                <Checkbox className="wt-check" checked={included} onCheckedChange={(next) => void update({ includeInReview: next === true })} aria-label="Include in review" />
                {included ? "In review" : "Not in review"}
              </label>
            ) : null}
          </div>
          {where ? (
            <button type="button" className="wt-it-loc" onClick={jump} aria-label={`Go to ${where}`}>
              {where}
            </button>
          ) : null}
          {/* The whole body jumps to the place too; the location above is its keyboard path. */}
          <div className="wt-it-body" onClick={where ? jump : undefined} data-jumps={where ? "" : undefined}>
            <p className="wt-it-text">{note.text}</p>
            {note.quote ? <blockquote className="wt-it-quote">{ellipsize(note.quote, 160)}</blockquote> : null}
          </div>
          {note.resolution ? (
            <div className="wt-it-res">
              <Markdown content={`**${note.kind === "todo" ? "Outcome" : "Answer"}:** ${note.resolution}`} />
            </div>
          ) : null}
          {note.status === "open" && note.proposedResolution ? (
            <div className="wt-it-proposal" role="group" aria-label="Suggested outcome">
              <div className="wt-it-res">
                <Markdown content={`**Suggested ${note.kind === "todo" ? "outcome" : "answer"}:** ${note.proposedResolution}`} />
              </div>
              <div className="wt-it-actions">
                <button type="button" className="wt-act" onClick={() => void rpc.call("acceptResolution", { walkthroughId: walkthrough.id, noteId: note.id }).catch(fail)}>
                  <Icon name="Check" className="size-3" aria-hidden />
                  Accept and resolve
                </button>
                <button type="button" className="wt-act" onClick={() => void rpc.call("dismissResolution", { walkthroughId: walkthrough.id, noteId: note.id }).catch(fail)}>
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
          {confirmingDelete ? (
            <div className="wt-it-actions wt-it-confirm" role="group" aria-label="Confirm delete">
              <span>Delete this {KIND_WORD[note.kind].toLowerCase()}?</span>
              <button type="button" className="wt-act wt-act-danger" onClick={() => void remove()}>
                Delete
              </button>
              <button type="button" className="wt-act" onClick={() => setConfirmingDelete(false)}>
                Keep
              </button>
            </div>
          ) : (
            <div className="wt-it-actions" role="group" aria-label="Actions">
              <button type="button" className="wt-act" onClick={() => void update({ status: note.status === "open" ? "resolved" : "open" })}>
                <Icon name={note.status === "open" ? "Check" : "RotateCcw"} className="size-3" aria-hidden />
                {note.status === "open" ? "Resolve" : "Reopen"}
              </button>
              <button type="button" className="wt-act" onClick={() => setEditing(true)}>
                <Icon name="Edit" className="size-3" aria-hidden />
                Edit
              </button>
              <button type="button" className="wt-act" onClick={() => setConfirmingDelete(true)}>
                <Icon name="Trash2" className="size-3" aria-hidden />
                Delete
              </button>
            </div>
          )}
        </>
      )}
    </li>
  );
}

/** The "Post review" button with its confirmation dialog; nothing is sent until the reader confirms there. */
export function PostReviewControl({ walkthrough, draft, rpc, disabled }: { walkthrough: Walkthrough; draft: ReviewDraftView | null; rpc: WalkthroughRpc; disabled?: boolean }) {
  const settled = walkthrough.pr?.state === "merged" || walkthrough.pr?.state === "closed";
  const comments = draft?.comments ?? [];
  const [confirming, setConfirming] = useState(false);
  const [event, setEvent] = useState<ReviewEvent>(settled ? "COMMENT" : (draft?.event ?? "COMMENT"));
  const [sending, setSending] = useState(false);
  const notify = useNotify();
  const fail = useFail();
  const post = async () => {
    setSending(true);
    try {
      await rpc.call("requestReviewPost", { walkthroughId: walkthrough.id, event });
      setConfirming(false);
      notify("Asked the agent to post the review");
    } catch (cause) {
      fail(cause);
    } finally {
      setSending(false);
    }
  };
  const body = draft?.body ?? "";
  return (
    <>
      <button type="button" className="wt-btn wt-btn-primary" disabled={disabled ?? (comments.length === 0 && body.trim() === "")} onClick={() => setConfirming(true)}>
        Post review
      </button>
      <PostReviewDialog
        open={confirming}
        onOpenChange={setConfirming}
        walkthrough={walkthrough}
        body={body}
        comments={comments}
        event={event}
        onEvent={setEvent}
        settled={settled}
        sending={sending}
        onPost={() => void post()}
      />
    </>
  );
}

function ReviewDraft({ walkthrough, draft, rpc }: { walkthrough: Walkthrough; draft: ReviewDraftView | null; rpc: WalkthroughRpc }) {
  const review = draft;
  const comments = draft?.comments ?? [];
  const posted = review?.status === "posted";
  const body = review?.body ?? "";
  const empty = comments.length === 0 && body.trim() === "";
  return (
    <>
      <div className="wt-sheet-body" role="tabpanel" aria-label="Review draft">
        {posted ? (
          <p className="wt-muted">
            Posted.{" "}
            {review?.url ? (
              <UrlLink href={review.url} className="wt-link">
                View on GitHub
              </UrlLink>
            ) : null}
          </p>
        ) : null}
        <section className="wt-it wt-summary-field" aria-label="Summary">
          <span className="wt-kind">Summary · {EVENT_LABEL[review?.event ?? "COMMENT"]}</span>
          {body.trim() ? (
            <div className="wt-it-text">
              <Markdown content={body} />
            </div>
          ) : (
            <p className="wt-muted">No summary yet. The agent writes one when you wrap up.</p>
          )}
        </section>
        {empty ? <p className="wt-muted">No inline comments yet. Include a comment from Open items to add it here.</p> : null}
        <ul className="wt-items">
          {comments.map((comment, index) => (
            <li key={`${comment.path}:${comment.line}:${index}`} className="wt-it">
              <span className="wt-kind">Comment · {comment.side === "LEFT" ? "old side (removed code)" : "new side"}</span>
              <LocationLink files={walkthrough} location={{ path: comment.path, startLine: comment.startLine ?? comment.line, endLine: comment.line }} className="wt-it-loc" />
              <div className="wt-it-text">
                <Markdown content={comment.body} />
              </div>
            </li>
          ))}
        </ul>
      </div>
      {!posted ? (
        <div className="wt-sheet-foot">
          <PostReviewControl walkthrough={walkthrough} draft={draft} rpc={rpc} />
        </div>
      ) : null}
    </>
  );
}

/** Shows exactly what will be posted to GitHub and waits for the reader to confirm. */
export function PostReviewDialog({
  open,
  onOpenChange,
  walkthrough,
  body,
  comments,
  event,
  onEvent,
  settled,
  sending,
  onPost,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  walkthrough: Walkthrough;
  body: string;
  comments: DraftComment[];
  event: ReviewEvent;
  onEvent: (event: ReviewEvent) => void;
  settled: boolean;
  sending: boolean;
  onPost: () => void;
}) {
  const pr = walkthrough.pr;
  const target = pr?.url ? prLabel(pr.url, pr.number) : `PR #${pr?.number}`;
  const inline = comments.length === 1 ? "1 inline comment" : `${comments.length} inline comments`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="wt-portal wt-dialog">
        <DialogHeader>
          <DialogTitle>Post review to GitHub {POST_AS[event]}</DialogTitle>
          <DialogDescription>
            Posts {body.trim() ? `the summary and ${inline}` : inline} to {target}. Nothing is sent until you press Post review.
          </DialogDescription>
        </DialogHeader>
        <div className="wt-post-target">
          {pr?.url ? (
            <p>
              <UrlLink href={pr.url} className="wt-link">
                {target}
              </UrlLink>
              {pr.title ? <span className="wt-muted"> · {pr.title}</span> : null}
            </p>
          ) : null}
          {pr?.state && pr.state !== "open" ? <p className="wt-post-warn">This PR is already {pr.state}.</p> : null}
          <p className="wt-post-warn">This posts publicly to GitHub as your gh account.</p>
        </div>
        {body.trim() || comments.length > 0 ? (
          <ul className="wt-post-preview" aria-label="What will be posted">
            {body.trim() ? (
              <li>
                <span className="wt-post-label">Summary</span>
                <span className="wt-post-body"><InlineCode text={ellipsize(body, 400)} /></span>
              </li>
            ) : null}
            {comments.map((comment, index) => (
              <li key={index}>
                <span className="wt-post-label">
                  Inline comment{" "}
                  <code>
                    {formatLocation({ path: comment.path, startLine: comment.startLine ?? comment.line, endLine: comment.line })}
                    {comment.side === "LEFT" ? " (old side)" : ""}
                  </code>
                </span>
                <span className="wt-post-body"><InlineCode text={ellipsize(comment.body, 240)} /></span>
              </li>
            ))}
          </ul>
        ) : null}
        <div role="radiogroup" aria-label="Review event">
          {(Object.keys(EVENT_LABEL) as ReviewEvent[]).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={event === candidate}
              // A merged or closed PR can still be commented on, but not approved or blocked.
              disabled={settled && candidate !== "COMMENT"}
              onClick={() => onEvent(candidate)}
            >
              {EVENT_LABEL[candidate]}
            </button>
          ))}
        </div>
        <DialogFooter className="wt-dialog-actions">
          <Button type="button" variant="ghost" className="wt-btn wt-btn-quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" className="wt-btn wt-btn-primary" disabled={sending} onClick={onPost}>
            Post review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
