// Notes and the PR review draft, shown in the pane's side drawer.
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatLocation, NOTE_KIND_LABEL, NOTE_SECTIONS, noteKindsFor, partLabel } from "../model.ts";
import type { Note, NoteKind, ReviewEvent, Walkthrough, WalkthroughView } from "../schemas.ts";
import { errorMessage, type WalkthroughRpc } from "./hooks.ts";
import { DiffView, LocationLink, Muted } from "./parts.tsx";

/** Applies a typed "12" or "12-40" to a location; anything else keeps the location's own range. */
function withLines(location: Walkthrough["parts"][number]["locations"][number] | null, lines: string) {
  if (!location) return null;
  const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/u.exec(lines);
  if (!match) return location;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  return { path: location.path, startLine: Math.min(start, end), ...(start === end ? {} : { endLine: Math.max(start, end) }) };
}

export interface NoteDraft {
  quote: string;
  groupIndex: number | null;
  sequence: number;
}


export function NotesTab({ view, rpc, draft, onDraftUsed }: { view: WalkthroughView; rpc: WalkthroughRpc; draft: NoteDraft | null; onDraftUsed: () => void }) {
  const { walkthrough, notes } = view;
  const resolved = notes.filter((note) => note.status === "resolved");
  const sections = NOTE_SECTIONS.map((section) => ({
    ...section,
    items: notes.filter((note) => note.kind === section.kind && note.status === "open"),
  })).filter((section) => section.items.length > 0);
  return (
    <div className="space-y-4">
      {walkthrough.status !== "done" ? <NoteComposer walkthrough={walkthrough} rpc={rpc} draft={draft} onDraftUsed={onDraftUsed} /> : null}
      {notes.length === 0 ? <Muted>No notes yet. Record questions and todos here or from the pause controls.</Muted> : null}
      {sections.map((section) => (
        <section key={section.kind} className="space-y-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{section.title}</h3>
          <ul className="space-y-1.5">
            {section.items.map((note) => (
              <NoteRow key={note.id} walkthrough={walkthrough} note={note} rpc={rpc} />
            ))}
          </ul>
        </section>
      ))}
      {resolved.length > 0 ? (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Resolved / Answered</h3>
          <ul className="space-y-1.5">
            {resolved.map((note) => (
              <NoteRow key={note.id} walkthrough={walkthrough} note={note} rpc={rpc} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function kindsFor(walkthrough: Walkthrough): NoteKind[] {
  return noteKindsFor(walkthrough.mode);
}

function NoteComposer({
  walkthrough,
  rpc,
  draft,
  onDraftUsed,
}: {
  walkthrough: Walkthrough;
  rpc: WalkthroughRpc;
  draft: NoteDraft | null;
  onDraftUsed: () => void;
}) {
  const [kind, setKind] = useState<NoteKind>("question");
  const [text, setText] = useState("");
  const [quote, setQuote] = useState<string | null>(null);
  const [groupIndex, setGroupIndex] = useState<number | null>(walkthrough.currentPart);
  const [locationIndex, setLocationIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!draft) return;
    setQuote(draft.quote);
    setGroupIndex(draft.groupIndex);
    onDraftUsed();
    textRef.current?.focus();
  }, [draft, onDraftUsed]);
  useEffect(() => {
    setGroupIndex(walkthrough.currentPart);
    setLocationIndex(-1);
  }, [walkthrough.currentPart]);
  const locations = groupIndex === null ? [] : walkthrough.parts[groupIndex]?.locations ?? [];
  const [lines, setLines] = useState("");
  const save = async () => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    setBusy(true);
    try {
      const note = await rpc.call("addNote", {
        walkthroughId: walkthrough.id,
        kind,
        text: trimmed,
        groupIndex,
        location: locationIndex >= 0 ? withLines(locations[locationIndex] ?? null, lines) : null,
        quote,
      });
      setText("");
      setQuote(null);
      toast.success(`Recorded ${NOTE_KIND_LABEL[kind].toLowerCase()} ${note.id}`);
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-2 rounded-md border border-border p-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Note kind">
        {kindsFor(walkthrough).map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={kind === candidate}
            onClick={() => setKind(candidate)}
            className={cn(
              "rounded-md px-2 py-0.5 text-xs",
              kind === candidate ? "bg-foreground text-background" : "text-muted-foreground hover:bg-state-hover",
            )}
          >
            {NOTE_KIND_LABEL[candidate]}
          </button>
        ))}
      </div>
      {quote ? (
        <div className="flex items-start gap-2 rounded bg-secondary/60 px-2 py-1 text-xs text-muted-foreground">
          <blockquote className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap">{quote}</blockquote>
          <button type="button" aria-label="Remove quote" onClick={() => setQuote(null)}>
            <Icon name="X" className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}
      <textarea
        ref={textRef}
        value={text}
        rows={2}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void save();
          }
        }}
        aria-label="Note text"
        placeholder={`New ${NOTE_KIND_LABEL[kind].toLowerCase()}`}
        className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={groupIndex ?? -1}
          onChange={(event) => {
            const value = Number(event.target.value);
            setGroupIndex(value < 0 ? null : value);
            setLocationIndex(-1);
          }}
          aria-label="Group"
          className="h-7 max-w-[12rem] rounded-md border border-input bg-transparent px-1.5 text-xs"
        >
          <option value={-1}>Whole walkthrough</option>
          {walkthrough.parts.map((group, index) => (
            <option key={`${index}:${group.title}`} value={index}>
              {index + 1}. {group.title}
            </option>
          ))}
        </select>
        {locations.length > 0 ? (
          <select
            value={locationIndex}
            onChange={(event) => {
              const index = Number(event.target.value);
              setLocationIndex(index);
              const chosen = locations[index];
              setLines(chosen?.startLine ? `${chosen.startLine}${chosen.endLine && chosen.endLine !== chosen.startLine ? `-${chosen.endLine}` : ""}` : "");
            }}
            aria-label="File"
            className="h-7 max-w-[12rem] rounded-md border border-input bg-transparent px-1.5 text-xs"
          >
            <option value={-1}>No file</option>
            {locations.map((location, index) => (
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
            className="h-7 w-20 rounded-md border border-input bg-transparent px-1.5 text-xs"
          />
        ) : null}
        <Button type="submit" size="sm" className="ml-auto h-7" disabled={busy || text.trim() === ""}>
          Record
        </Button>
      </div>
    </form>
  );
}

function NoteRow({ walkthrough, note, rpc }: { walkthrough: Walkthrough; note: Note; rpc: WalkthroughRpc }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [resolution, setResolution] = useState(note.resolution ?? "");
  const update = (patch: { kind?: NoteKind; text?: string; status?: Note["status"]; resolution?: string | null }) =>
    rpc.call("updateNote", { walkthroughId: walkthrough.id, noteId: note.id, ...patch }).catch((cause: unknown) => toast.error(errorMessage(cause)));
  const remove = () =>
    rpc.call("deleteNote", { walkthroughId: walkthrough.id, noteId: note.id }).catch((cause: unknown) => toast.error(errorMessage(cause)));
  const group = partLabel(walkthrough, note.groupIndex);
  return (
    <li className="group/note space-y-1 rounded-md border border-border px-2.5 py-2">
      {editing ? (
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void update({ text: text.trim() || note.text, resolution: resolution.trim() || null }).then(() => setEditing(false));
          }}
        >
          <textarea
            value={text}
            rows={2}
            onChange={(event) => setText(event.target.value)}
            aria-label="Note text"
            className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1 text-sm"
          />
          <textarea
            value={resolution}
            rows={1}
            onChange={(event) => setResolution(event.target.value)}
            aria-label="Answer"
            placeholder="Answer or outcome (optional)"
            className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1 text-xs"
          />
          <div className="flex items-center gap-1.5">
            <select
              value={note.kind}
              onChange={(event) => void update({ kind: event.target.value as NoteKind })}
              aria-label="Kind"
              className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs"
            >
              {kindsFor(walkthrough).map((kind) => (
                <option key={kind} value={kind}>
                  {NOTE_KIND_LABEL[kind]}
                </option>
              ))}
            </select>
            <Button type="button" size="sm" variant="ghost" className="ml-auto h-7" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" className="h-7">
              Save
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <p className={cn("min-w-0 flex-1 whitespace-pre-wrap text-sm", note.status === "resolved" && "text-muted-foreground")}>
              {note.status === "resolved" ? <span className="mr-1 text-xs">{NOTE_KIND_LABEL[note.kind]}:</span> : null}
              {note.text}
            </p>
            <div className="flex shrink-0 items-center opacity-60 group-hover/note:opacity-100 group-focus-within/note:opacity-100">
              <IconButton
                label={note.status === "open" ? "Mark resolved" : "Reopen"}
                icon={note.status === "open" ? "Check" : "RotateCcw"}
                onClick={() => void update({ status: note.status === "open" ? "resolved" : "open" })}
              />
              <IconButton label="Edit" icon="Edit" onClick={() => setEditing(true)} />
              <IconButton label="Delete" icon="Trash2" onClick={() => void remove()} />
            </div>
          </div>
          {note.quote ? (
            <blockquote className="line-clamp-3 border-l-2 border-border pl-2 text-xs text-muted-foreground">{note.quote}</blockquote>
          ) : null}
          {note.resolution ? (
            <div className="text-xs text-muted-foreground">
              <Markdown content={`**${note.kind === "todo" ? "Outcome" : "Answer"}:** ${note.resolution}`} />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{note.id}</span>
            {group ? <span className="truncate">{group}</span> : null}
            {note.location ? <LocationLink environmentId={walkthrough.environmentId} location={note.location} /> : null}
            {note.author === "agent" ? <span className="rounded bg-secondary px-1 text-secondary-foreground">agent</span> : null}
          </div>
        </>
      )}
    </li>
  );
}

function IconButton({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
    >
      <Icon name={icon} className="size-3.5" aria-hidden />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Review draft (PR mode)
// ---------------------------------------------------------------------------

const EVENT_LABEL: Record<ReviewEvent, string> = {
  COMMENT: "Comment",
  REQUEST_CHANGES: "Request changes",
  APPROVE: "Approve",
};

export function ReviewTab({ walkthrough, rpc }: { walkthrough: Walkthrough; rpc: WalkthroughRpc }) {
  const review = walkthrough.review;
  const [confirming, setConfirming] = useState(false);
  const [event, setEvent] = useState<ReviewEvent>(review?.event ?? "COMMENT");
  const [sending, setSending] = useState(false);
  const markdown = useMemo(() => {
    if (!review) return "";
    const inline = review.comments.map(
      (comment) => `- \`${comment.path}:${comment.startLine ? `${comment.startLine}-` : ""}${comment.line}\` ${comment.body}`,
    );
    return [review.body, inline.length ? `\n**Inline comments**\n\n${inline.join("\n")}` : ""].join("\n").trim();
  }, [review]);
  if (!review) {
    return (
      <div className="space-y-2">
        <Muted>No draft review yet.</Muted>
        <Muted>At the finish, after todos and questions, the agent offers to draft one from your comments and open questions.</Muted>
      </div>
    );
  }
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
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground">
          {review.status === "posted" ? "Posted" : "Draft"}
        </span>
        <span>{EVENT_LABEL[review.event]}</span>
        <span>· {review.comments.length} inline</span>
        {review.status === "posted" && review.url ? (
          <UrlLink href={review.url} className="underline-offset-2 hover:underline">
            View on GitHub
          </UrlLink>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-7 px-2"
          onClick={() => {
            void navigator.clipboard.writeText(markdown).then(
              () => toast.success("Copied the draft review"),
              () => toast.error("Could not copy"),
            );
          }}
        >
          <Icon name="Copy" className="size-3.5" aria-hidden />
          Copy
        </Button>
        {review.status === "draft" ? (
          <Button type="button" size="sm" className="h-7" onClick={() => setConfirming(true)}>
            <Icon name="Sent" className="size-3.5" aria-hidden />
            Post…
          </Button>
        ) : null}
      </div>
      <section className="space-y-1">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review body</h3>
        <div className="rounded-md border border-border px-3 py-2 text-sm">
          {review.body.trim() ? <Markdown content={review.body} /> : <Muted>Empty</Muted>}
        </div>
      </section>
      {review.comments.length > 0 ? (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Inline comments</h3>
          <ul className="space-y-1.5">
            {review.comments.map((comment, index) => (
              <li key={`${comment.path}:${comment.line}:${index}`} className="space-y-1 rounded-md border border-border px-3 py-2">
                <LocationLink
                  environmentId={walkthrough.environmentId}
                  location={{
                    path: comment.path,
                    startLine: comment.startLine ?? comment.line,
                    endLine: comment.line,
                  }}
                />
                {comment.side === "LEFT" ? <span className="ml-2 text-xs text-muted-foreground">old side</span> : null}
                <div className="text-sm">
                  <Markdown content={comment.body} />
                </div>
                {comment.side === "RIGHT" ? (
                  <DiffView
                    walkthrough={walkthrough}
                    location={{
                      path: comment.path,
                      startLine: Math.max(1, (comment.startLine ?? comment.line) - 3),
                      endLine: comment.line + 3,
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Post review to PR #{walkthrough.pr?.number}?</DialogTitle>
            <DialogDescription>
              The agent submits the body and {review.comments.length} inline comments exactly as drafted.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Review event">
            {(Object.keys(EVENT_LABEL) as ReviewEvent[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={event === candidate}
                onClick={() => setEvent(candidate)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-sm",
                  event === candidate ? "border-foreground bg-foreground text-background" : "border-border hover:bg-state-hover",
                )}
              >
                {EVENT_LABEL[candidate]}
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={sending} onClick={() => void post()}>
              Post review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

