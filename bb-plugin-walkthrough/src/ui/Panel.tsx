// The Walkthrough side panel: outline with per-group diffs, the notes list
// with full editing, and (PR mode) the draft review preview.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Markdown,
  experimental_FileLink as FileLink,
  UrlLink,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatLocation, groupLabel, NOTE_KIND_LABEL, NOTE_SECTIONS, primaryNoteKinds, shortRef } from "../model.ts";
import type { Group, Note, NoteKind, ReviewEvent, Walkthrough, WalkthroughView } from "../schemas.ts";
import { clearNoteDraft, errorMessage, useNoteDraft, useWalkthrough, type WalkthroughRpc } from "./hooks.ts";
import { DiffView, GroupStatusIcon, LocationLink, Muted } from "./parts.tsx";

type Tab = "outline" | "notes" | "review";

const STATUS_LABEL: Record<Walkthrough["status"], string> = {
  overview: "Overview",
  reviewing: "Reviewing",
  finishing: "Finishing",
  finished: "Finished",
};

export function WalkthroughPanel({ threadId }: PluginThreadPanelProps) {
  const { view, loaded, error, rpc } = useWalkthrough(threadId);
  const draft = useNoteDraft(threadId);
  const [tab, setTab] = useState<Tab>("outline");
  useEffect(() => {
    if (draft) setTab("notes");
  }, [draft]);

  if (!loaded) {
    return <Muted className="p-4">{error ?? "Loading walkthrough…"}</Muted>;
  }
  if (view === null) {
    return (
      <div className="space-y-2 p-4">
        <Muted>No walkthrough in this thread yet.</Muted>
        <Muted>Ask the agent to walk you through the changes, for example “Walk me through this PR for review.”</Muted>
      </div>
    );
  }
  const { walkthrough, notes } = view;
  const openNotes = notes.filter((note) => note.status === "open").length;
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "outline", label: "Outline" },
    { id: "notes", label: openNotes > 0 ? `Notes (${openNotes})` : "Notes" },
    ...(walkthrough.mode === "pr" ? [{ id: "review" as const, label: "Review" }] : []),
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader threadId={threadId} view={view} rpc={rpc} />
      <div role="tablist" aria-label="Walkthrough views" className="flex gap-1 border-b border-border px-3">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={cn(
              "-mb-px border-b-2 px-2 py-2 text-sm",
              tab === entry.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "outline" ? <OutlineTab threadId={threadId} walkthrough={walkthrough} notes={notes} /> : null}
        {tab === "notes" ? <NotesTab threadId={threadId} view={view} rpc={rpc} /> : null}
        {tab === "review" ? <ReviewTab threadId={threadId} walkthrough={walkthrough} rpc={rpc} /> : null}
      </div>
    </div>
  );
}

function PanelHeader({ threadId, view, rpc }: { threadId: string; view: WalkthroughView; rpc: WalkthroughRpc }) {
  const { walkthrough } = view;
  const covered = walkthrough.groups.filter((group) => group.status === "done").length;
  const [opening, setOpening] = useState(false);
  const showControls = async () => {
    setOpening(true);
    try {
      const { opened } = await rpc.call("showPause", { threadId });
      if (!opened) toast.info("The controls return when the agent finishes its current turn.");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setOpening(false);
    }
  };
  const toggleNotesFile = (enabled: boolean) => {
    rpc.call("setNotesFileEnabled", { threadId, enabled }).catch((cause: unknown) => toast.error(errorMessage(cause)));
  };
  const notesFile = walkthrough.notesFile;
  return (
    <div className="space-y-2 border-b border-border p-3">
      <div className="flex items-start gap-2">
        <Icon name="Explore" className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium" title={walkthrough.title}>
            {walkthrough.title}
          </h2>
          <p className="text-xs text-muted-foreground">
            {walkthrough.mode === "pr" && walkthrough.pr ? (
              walkthrough.pr.url ? (
                <UrlLink href={walkthrough.pr.url} className="underline-offset-2 hover:underline">
                  PR #{walkthrough.pr.number}
                </UrlLink>
              ) : (
                `PR #${walkthrough.pr.number}`
              )
            ) : (
              "Local review"
            )}
            {" · "}
            base <code title={walkthrough.baseRef}>{shortRef(walkthrough.baseRef)}</code>
            {" · "}
            {STATUS_LABEL[walkthrough.status]}
            {walkthrough.groups.length > 0 ? ` · ${covered}/${walkthrough.groups.length} groups` : ""}
          </p>
        </div>
        {view.pauseRequested ? (
          <Button type="button" size="sm" variant="outline" disabled={opening} onClick={() => void showControls()}>
            <Icon name="Play" className="size-3.5" aria-hidden />
            Show controls
          </Button>
        ) : null}
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          id={`${threadId}-notes-file`}
          checked={notesFile.enabled}
          onCheckedChange={(checked) => toggleNotesFile(checked === true)}
          disabled={notesFile.path === null}
        />
        <label htmlFor={`${threadId}-notes-file`}>Keep notes file</label>
        {notesFile.path && notesFile.written && walkthrough.hostId ? (
          <FileLink
            target={{ kind: "host", hostId: walkthrough.hostId, path: notesFile.path }}
            className="min-w-0 truncate font-mono underline-offset-2 hover:underline"
          >
            .agent/review-notes.md
          </FileLink>
        ) : (
          <span className="min-w-0 truncate font-mono">{notesFile.path ? ".agent/review-notes.md (after the first note)" : "no workspace"}</span>
        )}
        {notesFile.error ? (
          <span className="text-destructive" title={notesFile.error}>
            write failed
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

function OutlineTab({ threadId, walkthrough, notes }: { threadId: string; walkthrough: Walkthrough; notes: Note[] }) {
  const [expanded, setExpanded] = useState<number | null>(walkthrough.currentGroup);
  const current = walkthrough.currentGroup;
  const previous = useRef(current);
  useEffect(() => {
    if (previous.current !== current) setExpanded(current);
    previous.current = current;
  }, [current]);
  if (walkthrough.groups.length === 0) return <Muted>No groups yet.</Muted>;
  return (
    <ol className="space-y-1.5">
      {walkthrough.groups.map((group, index) => (
        <GroupRow
          key={`${index}:${group.title}`}
          threadId={threadId}
          walkthrough={walkthrough}
          group={group}
          index={index}
          noteCount={notes.filter((note) => note.groupIndex === index && note.status === "open").length}
          expanded={expanded === index}
          onToggle={() => setExpanded(expanded === index ? null : index)}
        />
      ))}
    </ol>
  );
}

function GroupRow({
  threadId,
  walkthrough,
  group,
  index,
  noteCount,
  expanded,
  onToggle,
}: {
  threadId: string;
  walkthrough: Walkthrough;
  group: Group;
  index: number;
  noteCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [diffFor, setDiffFor] = useState<Set<number>>(() => new Set());
  const toggleDiff = (locationIndex: number) =>
    setDiffFor((current) => {
      const next = new Set(current);
      if (next.has(locationIndex)) next.delete(locationIndex);
      else next.add(locationIndex);
      return next;
    });
  return (
    <li
      className={cn(
        "rounded-md border",
        group.status === "current" ? "border-foreground/40 bg-card" : "border-border",
        group.status === "skipped" && "opacity-70",
      )}
    >
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex w-full items-start gap-2 px-3 py-2 text-left">
        <GroupStatusIcon status={group.status} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm">
            <span className="text-muted-foreground">{index + 1}.</span> {group.title}
          </span>
          {group.summary && !expanded ? <span className="block truncate text-xs text-muted-foreground">{group.summary}</span> : null}
        </span>
        {noteCount > 0 ? <span className="rounded-full bg-secondary px-1.5 text-xs text-secondary-foreground">{noteCount}</span> : null}
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {expanded ? (
        <div className="space-y-2 px-3 pb-3">
          {group.summary ? <p className="text-xs text-muted-foreground">{group.summary}</p> : null}
          {group.locations.length === 0 ? (
            <Muted className="text-xs">No file references for this group.</Muted>
          ) : (
            <ul className="space-y-1.5">
              {group.locations.map((location, locationIndex) => (
                <li key={`${location.path}:${locationIndex}`} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <LocationLink environmentId={walkthrough.environmentId} location={location} className="min-w-0 truncate" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 px-2 text-xs"
                      aria-pressed={diffFor.has(locationIndex)}
                      onClick={() => toggleDiff(locationIndex)}
                    >
                      <Icon name="FileDiff" className="size-3.5" aria-hidden />
                      Diff
                    </Button>
                  </div>
                  {diffFor.has(locationIndex) ? (
                    <DiffView threadId={threadId} walkthrough={walkthrough} location={location} withFullFile={location.startLine === undefined} />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function NotesTab({ threadId, view, rpc }: { threadId: string; view: WalkthroughView; rpc: WalkthroughRpc }) {
  const { walkthrough, notes } = view;
  const resolved = notes.filter((note) => note.status === "resolved");
  const sections = NOTE_SECTIONS.map((section) => ({
    ...section,
    items: notes.filter((note) => note.kind === section.kind && note.status === "open"),
  })).filter((section) => section.items.length > 0);
  return (
    <div className="space-y-4">
      {walkthrough.status !== "finished" ? <NoteComposer threadId={threadId} walkthrough={walkthrough} rpc={rpc} /> : null}
      {notes.length === 0 ? <Muted>No notes yet. Record questions and todos here or from the pause controls.</Muted> : null}
      {sections.map((section) => (
        <section key={section.kind} className="space-y-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{section.title}</h3>
          <ul className="space-y-1.5">
            {section.items.map((note) => (
              <NoteRow key={note.id} threadId={threadId} walkthrough={walkthrough} note={note} rpc={rpc} />
            ))}
          </ul>
        </section>
      ))}
      {resolved.length > 0 ? (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Resolved / Answered</h3>
          <ul className="space-y-1.5">
            {resolved.map((note) => (
              <NoteRow key={note.id} threadId={threadId} walkthrough={walkthrough} note={note} rpc={rpc} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function kindsFor(walkthrough: Walkthrough): NoteKind[] {
  const primary = primaryNoteKinds(walkthrough.mode);
  return [...primary, ...(["question", "todo", "comment", "note"] as NoteKind[]).filter((kind) => !primary.includes(kind))];
}

function NoteComposer({ threadId, walkthrough, rpc }: { threadId: string; walkthrough: Walkthrough; rpc: WalkthroughRpc }) {
  const draft = useNoteDraft(threadId);
  const [kind, setKind] = useState<NoteKind>("question");
  const [text, setText] = useState("");
  const [quote, setQuote] = useState<string | null>(null);
  const [groupIndex, setGroupIndex] = useState<number | null>(walkthrough.currentGroup);
  const [locationIndex, setLocationIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!draft) return;
    setQuote(draft.quote);
    clearNoteDraft(threadId);
    textRef.current?.focus();
  }, [draft, threadId]);
  useEffect(() => {
    setGroupIndex(walkthrough.currentGroup);
    setLocationIndex(-1);
  }, [walkthrough.currentGroup]);
  const locations = groupIndex === null ? [] : walkthrough.groups[groupIndex]?.locations ?? [];
  const save = async () => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    setBusy(true);
    try {
      const note = await rpc.call("addNote", {
        threadId,
        kind,
        text: trimmed,
        groupIndex,
        location: locationIndex >= 0 ? locations[locationIndex] ?? null : null,
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
          <option value={-1}>Whole review</option>
          {walkthrough.groups.map((group, index) => (
            <option key={`${index}:${group.title}`} value={index}>
              {index + 1}. {group.title}
            </option>
          ))}
        </select>
        {locations.length > 0 ? (
          <select
            value={locationIndex}
            onChange={(event) => setLocationIndex(Number(event.target.value))}
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
        <Button type="submit" size="sm" className="ml-auto h-7" disabled={busy || text.trim() === ""}>
          Record
        </Button>
      </div>
    </form>
  );
}

function NoteRow({ threadId, walkthrough, note, rpc }: { threadId: string; walkthrough: Walkthrough; note: Note; rpc: WalkthroughRpc }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [resolution, setResolution] = useState(note.resolution ?? "");
  const update = (patch: { kind?: NoteKind; text?: string; status?: Note["status"]; resolution?: string | null }) =>
    rpc.call("updateNote", { threadId, noteId: note.id, ...patch }).catch((cause: unknown) => toast.error(errorMessage(cause)));
  const remove = () =>
    rpc.call("deleteNote", { threadId, noteId: note.id }).catch((cause: unknown) => toast.error(errorMessage(cause)));
  const group = groupLabel(walkthrough, note.groupIndex);
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

function ReviewTab({ threadId, walkthrough, rpc }: { threadId: string; walkthrough: Walkthrough; rpc: WalkthroughRpc }) {
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
      await rpc.call("requestReviewPost", { threadId, event });
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
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground">
          {review.status === "posted" ? "Posted" : "Draft"}
        </span>
        <span>{EVENT_LABEL[review.event]}</span>
        <span>· {review.comments.length} inline</span>
        {review.url ? (
          <UrlLink href={review.url} className="underline-offset-2 hover:underline">
            View on GitHub
          </UrlLink>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-7"
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
                    threadId={threadId}
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

