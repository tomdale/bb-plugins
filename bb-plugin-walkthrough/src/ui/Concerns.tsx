// The concerns sheet: everything the reader flagged (notes, todos, comments,
// questions) in one list, plus the review draft for a PR. It overlays the page
// from the right and never reflows it.
import { useMemo, useState, type MutableRefObject } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatLocation, NOTE_KIND_LABEL, noteKindsFor } from "../model.ts";
import type { DeliveredNote as Note, DeliveredWalkthrough as Walkthrough, NoteKind, ReviewEvent, WalkthroughView } from "../schemas.ts";
import { baseName } from "./fields.ts";
import { Hint } from "./Hint.tsx";
import { errorMessage, type WalkthroughRpc } from "./hooks.ts";
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

/** The review as the pane shows it: the worker's draft merged with the comments the reader included (see `reviewDraft` on the view). */
export type ReviewDraftView = NonNullable<WalkthroughView["reviewDraft"]>;
type DraftComment = ReviewDraftView["comments"][number];

const EVENT_LABEL: Record<ReviewEvent, string> = { COMMENT: "Comment", REQUEST_CHANGES: "Request changes", APPROVE: "Approve" };

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
}: {
  view: WalkthroughView;
  rpc: WalkthroughRpc;
  open: boolean;
  tab: ConcernsTab;
  onTab: (tab: ConcernsTab) => void;
  onClose: () => void;
  onJump: (groupIndex: number) => void;
  sheetRef: MutableRefObject<HTMLElement | null>;
}) {
  const { walkthrough, notes } = view;
  const reviewable = hasReview(walkthrough);
  const openItems = useMemo(() => openConcerns(notes), [notes]);
  const resolved = notes.filter((note) => note.status === "resolved");
  const [showResolved, setShowResolved] = useState(false);
  const comments = view.reviewDraft?.comments ?? [];
  const [sending, setSending] = useState(false);
  const activeTab = reviewable ? tab : "open";
  const handOff = async () => {
    setSending(true);
    try {
      const { sent } = await rpc.call("handOff", { walkthroughId: walkthrough.id });
      toast[sent ? "success" : "info"](sent ? "Sent the open items to your thread." : "There are no new todos or questions to send.");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSending(false);
    }
  };
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
          Open items · {openItems.length}
        </button>
        {reviewable ? (
          <button type="button" role="tab" aria-selected={activeTab === "review"} onClick={() => onTab("review")}>
            Review draft · {comments.length}
          </button>
        ) : null}
        <span className="wt-sp" />
        <Hint label="Close">
          <button type="button" className="wt-icon-btn" aria-label="Close concerns" onClick={onClose}>
            <Icon name="X" className="size-3.5" aria-hidden />
          </button>
        </Hint>
      </div>
      {activeTab === "open" ? (
        <>
          <div className="wt-sheet-body" role="tabpanel" aria-label="Open items">
            {openItems.length === 0 ? <p className="wt-muted">Nothing flagged yet. Select text or a line of code to flag it.</p> : null}
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
          <div className="wt-sheet-foot">
            <button type="button" className="wt-btn wt-btn-quiet" disabled={sending} onClick={() => void handOff()}>
              Send open items to thread
            </button>
          </div>
        </>
      ) : (
        <ReviewDraft walkthrough={walkthrough} draft={view.reviewDraft} rpc={rpc} />
      )}
    </aside>
  );
}

function ConcernItem({ walkthrough, note, rpc, onJump }: { walkthrough: Walkthrough; note: Note; rpc: WalkthroughRpc; onJump: (groupIndex: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [answer, setAnswer] = useState(note.resolution ?? "");
  const [kind, setKind] = useState<NoteKind>(note.kind);
  const fail = (cause: unknown) => toast.error(errorMessage(cause));
  const update = (patch: Record<string, unknown>) => rpc.call("updateNote", { walkthroughId: walkthrough.id, noteId: note.id, ...patch } as never).catch(fail);
  const remove = () => rpc.call("deleteNote", { walkthroughId: walkthrough.id, noteId: note.id }).catch(fail);
  const part = note.groupIndex === null ? null : walkthrough.parts[note.groupIndex];
  const where = [part ? `Part ${(note.groupIndex ?? 0) + 1}` : null, note.location ? formatLocation({ ...note.location, path: baseName(note.location.path) }) : null].filter(Boolean).join(" · ");
  const reviewable = hasReview(walkthrough) && note.status === "open" && (note.kind === "comment" || note.kind === "note" || note.kind === "todo");
  const included = note.includeInReview;
  return (
    <li className={cn("wt-it", note.status === "resolved" && "wt-it-done")} data-note-id={note.id}>
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
            <span className="wt-kind">{KIND_WORD[note.kind]}</span>
            {note.author === "agent" ? <span className="wt-kind">· agent</span> : null}
            {note.sentAt ? <span className="wt-kind">· sent</span> : null}
            <span className="wt-sp" />
            <span className="wt-it-actions">
              <Hint label={note.status === "open" ? "Mark resolved" : "Reopen"}>
                <button type="button" className="wt-icon-btn" aria-label={note.status === "open" ? "Mark resolved" : "Reopen"} onClick={() => void update({ status: note.status === "open" ? "resolved" : "open" })}>
                  <Icon name={note.status === "open" ? "Check" : "RotateCcw"} className="size-3.5" aria-hidden />
                </button>
              </Hint>
              <Hint label="Edit">
                <button type="button" className="wt-icon-btn" aria-label="Edit" onClick={() => setEditing(true)}>
                  <Icon name="Edit" className="size-3.5" aria-hidden />
                </button>
              </Hint>
              <Hint label="Delete">
                <button type="button" className="wt-icon-btn" aria-label="Delete" onClick={() => void remove()}>
                  <Icon name="Trash2" className="size-3.5" aria-hidden />
                </button>
              </Hint>
            </span>
          </div>
          {where ? (
            note.groupIndex !== null ? (
              <button type="button" className="wt-it-loc" onClick={() => onJump(note.groupIndex!)}>
                {where}
              </button>
            ) : (
              <span className="wt-it-loc">{where}</span>
            )
          ) : null}
          <p className="wt-it-text">{note.text}</p>
          {note.quote ? <blockquote className="wt-it-quote">{note.quote}</blockquote> : null}
          {note.resolution ? (
            <div className="wt-it-res">
              <Markdown content={`**${note.kind === "todo" ? "Outcome" : "Answer"}:** ${note.resolution}`} />
            </div>
          ) : null}
          {reviewable ? (
            <label className="wt-include">
              <Checkbox checked={included} onCheckedChange={(next) => void update({ includeInReview: next === true })} aria-label="Include in review" />
              Include in review
            </label>
          ) : null}
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
  const post = async () => {
    setSending(true);
    try {
      await rpc.call("requestReviewPost", { walkthroughId: walkthrough.id, event });
      setConfirming(false);
      toast.success("Asked the agent to post the review.");
    } catch (cause) {
      toast.error(errorMessage(cause));
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
        {empty ? <p className="wt-muted">No review comments yet. Include a comment from Open items to add it here.</p> : null}
        {body.trim() ? (
          <section className="wt-it">
            <span className="wt-kind">Summary · {EVENT_LABEL[review?.event ?? "COMMENT"]}</span>
            <div className="wt-it-text">
              <Markdown content={body} />
            </div>
          </section>
        ) : null}
        <ul className="wt-items">
          {comments.map((comment, index) => (
            <li key={`${comment.path}:${comment.line}:${index}`} className="wt-it">
              <span className="wt-kind">Comment{comment.side === "LEFT" ? " · old side" : ""}</span>
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Post review to PR #{pr?.number}?</DialogTitle>
          <DialogDescription>
            The agent submits {body.trim() ? "the summary and " : ""}
            {comments.length === 1 ? "1 inline comment" : `${comments.length} inline comments`} as shown here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 text-sm">
          {pr?.url ? (
            <p>
              <UrlLink href={pr.url} className="break-all underline underline-offset-2">
                {prLabel(pr.url, pr.number)}
              </UrlLink>
              {pr.title ? <span className="text-muted-foreground"> · {pr.title}</span> : null}
            </p>
          ) : null}
          {pr?.state && pr.state !== "open" ? <p className="font-medium">This PR is already {pr.state}.</p> : null}
          <p className="font-medium">This posts publicly to GitHub as your gh account.</p>
        </div>
        {body.trim() || comments.length > 0 ? (
          <ul className="max-h-48 space-y-1.5 overflow-y-auto text-sm" aria-label="What will be posted">
            {body.trim() ? <li className="text-muted-foreground">{body.trim().slice(0, 240)}</li> : null}
            {comments.map((comment, index) => (
              <li key={index}>
                <code className="text-xs text-muted-foreground">{formatLocation({ path: comment.path, startLine: comment.line })}</code> {comment.body.slice(0, 160)}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Review event">
          {(Object.keys(EVENT_LABEL) as ReviewEvent[]).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={event === candidate}
              // A merged or closed PR can still be commented on, but not approved or blocked.
              disabled={settled && candidate !== "COMMENT"}
              onClick={() => onEvent(candidate)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-sm disabled:opacity-40",
                event === candidate ? "border-foreground bg-foreground text-background" : "border-border hover:bg-state-hover",
              )}
            >
              {EVENT_LABEL[candidate]}
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={sending} onClick={onPost}>
            Post review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
