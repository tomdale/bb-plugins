import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { experimental_Icon as Icon, useComposer, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils.js";
import { Button } from "./components/ui/button.js";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./components/ui/alert-dialog.js";
import { blockerCandidates, buildEditorView, statusOptions, structuralChange, type EditorNode } from "./editor-model.js";
import type { Input, Task } from "./model.js";
import { ProgressRing } from "./progress-ring.js";
import { useTodoList } from "./use-todos.js";

type Mutate = (change: Input) => Promise<boolean>;

const STATUS_TEXT: Record<Task["status"], string> = { in_progress: "In progress", pending: "Pending", completed: "Completed", deleted: "Deleted" };
const ICON_BUTTON = "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-state-active data-[state=open]:text-foreground disabled:cursor-default disabled:opacity-50 [&_[data-icon-root]]:size-3.5";
type StructuralCommand = "up" | "down" | "indent" | "outdent";
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "Meta" : "Control";
const SHORTCUT_ARIA = `Alt+ArrowUp Alt+ArrowDown ${MOD}+] ${MOD}+[`;
const SHORTCUT_LABELS: Record<StructuralCommand, string> = IS_MAC
  ? { up: "⌥↑", down: "⌥↓", indent: "⌘]", outdent: "⌘[" }
  : { up: "Alt+↑", down: "Alt+↓", indent: "Ctrl+]", outdent: "Ctrl+[" };

/**
 * Subject-field shortcuts: Alt+Up/Down move like an editor's move-line, and
 * Mod+]/[ indent like an editor's indent. Alt+Left/Right stay free for word
 * navigation and Tab stays free for focus order.
 */
function structuralShortcut(event: KeyboardEvent): StructuralCommand | null {
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;
  if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
    if (event.key === "ArrowUp") return "up";
    if (event.key === "ArrowDown") return "down";
  }
  if (mod && !event.altKey && !event.shiftKey) {
    if (event.key === "]") return "indent";
    if (event.key === "[") return "outdent";
  }
  return null;
}

const FIELD = "w-full rounded-md border border-input bg-transparent px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function findEditorNode(nodes: readonly EditorNode[], id: number): EditorNode | undefined {
  for (const node of nodes) {
    if (node.task.id === id) return node;
    const child = findEditorNode(node.children, id);
    if (child) return child;
  }
  return undefined;
}

/**
 * A text field that edits one stored value and commits on blur or Enter.
 * Escape restores the stored value. It re-seeds whenever the stored value
 * changes, so an agent edit replaces an untouched draft.
 */
function CommitField({ value, onCommit, multiline, required, className, onKeyDown, ...rest }: {
  value: string;
  /** A blank draft reverts to the stored value instead of committing. */
  required?: boolean;
  onCommit: (next: string) => void;
  multiline?: boolean;
  className?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  "aria-label"?: string;
  "aria-keyshortcuts"?: string;
  "data-subject-for"?: number;
  id?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => {
    if (required && !draft.trim()) { setDraft(value); return; }
    if (draft !== value) onCommit(draft);
  };
  const keys = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") { setDraft(value); event.currentTarget.blur(); return; }
    if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); return; }
    onKeyDown?.(event);
  };
  const shared = { ...rest, value: draft, className, onBlur: commit, onKeyDown: keys };
  return multiline
    ? <textarea {...shared} rows={3} onChange={event => setDraft(event.target.value)} />
    : <input {...shared} type="text" onChange={event => setDraft(event.target.value)} />;
}

function statusIcon(node: EditorNode): string {
  if (node.task.status === "completed") return "CircleCheck";
  if (node.task.status === "in_progress") return "Spinner";
  return node.waitingOn.length ? "Lock" : "Circle";
}

function StatusControl({ node, mutate, running }: { node: EditorNode; mutate: Mutate; running: boolean }) {
  const { task } = node;
  const icon = <Icon name={statusIcon(node)} aria-hidden="true"
    className={cn(task.status === "in_progress" && running && "animate-spin", task.status === "in_progress" ? "text-foreground" : "text-muted-foreground")} />;
  // Completed is terminal, so there is nothing to choose.
  if (task.status === "completed") {
    return <span className="inline-flex size-6 shrink-0 items-center justify-center [&_[data-icon-root]]:size-3.5" title="Completed">
      {icon}<span className="sr-only">Completed</span>
    </span>;
  }
  return <DropdownMenu>
    <DropdownMenuTrigger className={ICON_BUTTON} aria-label={`Status for #${task.id}: ${STATUS_TEXT[task.status]}${node.waitingOn.length ? ", waiting" : ""}`}>
      {icon}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" mobileTitle={`Status for #${task.id}`} className="min-w-44">
      {statusOptions(task).map(option => <DropdownMenuItem key={option.status} role="menuitemradio" aria-checked={task.status === option.status}
        disabled={option.disabled} onSelect={() => { if (option.status !== task.status) void mutate({ action: "update", id: task.id, status: option.status }); }}>
        <Icon name={option.status === "completed" ? "CircleCheck" : option.status === "in_progress" ? "Spinner" : "Circle"} aria-hidden="true" />
        <span className="flex min-w-0 flex-col">
          <span>{option.label}</span>
          {option.reason && <span className="text-2xs text-muted-foreground">{option.reason}</span>}
        </span>
        {task.status === option.status && <Icon name="Check" className="ml-auto" aria-hidden="true" />}
      </DropdownMenuItem>)}
      {node.waitingOn.length > 0 && <p className="px-2 pb-1 pt-1.5 text-2xs text-muted-foreground">Waiting for {node.waitingOn.map(id => `#${id}`).join(", ")}</p>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function RowMenu({ node, mutate }: { node: EditorNode; mutate: Mutate }) {
  const run = (command: StructuralCommand) => {
    const change = structuralChange(node, command);
    if (change) void mutate(change);
  };
  return <DropdownMenu>
    <DropdownMenuTrigger className={ICON_BUTTON} aria-label={`More actions for #${node.task.id}`}>
      <Icon name="MoreHorizontal" aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" mobileTitle={`#${node.task.id} ${node.task.subject}`} className="min-w-48">
      <DropdownMenuItem disabled={!node.canMoveUp} onSelect={() => run("up")}><Icon name="ArrowUp" aria-hidden="true" />Move up<DropdownMenuShortcut>{SHORTCUT_LABELS.up}</DropdownMenuShortcut></DropdownMenuItem>
      <DropdownMenuItem disabled={!node.canMoveDown} onSelect={() => run("down")}><Icon name="ArrowDown" aria-hidden="true" />Move down<DropdownMenuShortcut>{SHORTCUT_LABELS.down}</DropdownMenuShortcut></DropdownMenuItem>
      <DropdownMenuItem disabled={node.indentParentId === undefined} onSelect={() => run("indent")}>
        <Icon name="ArrowRight" aria-hidden="true" />{node.indentParentId === undefined ? "Make subtask" : `Make subtask of #${node.indentParentId}`}<DropdownMenuShortcut>{SHORTCUT_LABELS.indent}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem disabled={node.outdentParentId === undefined} onSelect={() => run("outdent")}>
        <Icon name="ArrowLeft" aria-hidden="true" />Move out of parent<DropdownMenuShortcut>{SHORTCUT_LABELS.outdent}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={() => { void mutate({ action: "delete", id: node.task.id }); }}>
        <Icon name="Trash2" aria-hidden="true" />Delete
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

function Field({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return <div className="grid gap-1">
    <label htmlFor={htmlFor} className="text-2xs font-medium text-muted-foreground">{label}</label>
    {children}
  </div>;
}

function TaskDetails({ node, view, mutate, id }: { node: EditorNode; view: ReturnType<typeof buildEditorView>; mutate: Mutate; id: string }) {
  const { task } = node;
  const byId = new Map(view.ordered.map(other => [other.id, other]));
  const update = (change: Omit<Input, "action" | "id">) => void mutate({ action: "update", id: task.id, ...change });
  const candidates = blockerCandidates(task, view.ordered);
  return <div id={id} role="group" aria-label={`Details for #${task.id}`} className="mb-2 ml-9 mr-1 mt-1 grid gap-3 rounded-md border border-border bg-surface-raised-solid p-3">
    <Field label="Description" htmlFor={`${id}-description`}>
      <CommitField id={`${id}-description`} multiline value={task.description ?? ""} placeholder="Notes for whoever works on this"
        className={cn(FIELD, "min-h-16 resize-y py-1.5 leading-relaxed")} onCommit={description => update({ description })} />
    </Field>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Working label" htmlFor={`${id}-active`}>
        <CommitField id={`${id}-active`} value={task.activeForm ?? ""} placeholder="Shown while in progress"
          className={cn(FIELD, "h-7")} onCommit={activeForm => update({ activeForm })} />
      </Field>
      <Field label="Owner" htmlFor={`${id}-owner`}>
        <CommitField id={`${id}-owner`} value={task.owner ?? ""} placeholder="Unassigned"
          className={cn(FIELD, "h-7")} onCommit={owner => update({ owner })} />
      </Field>
    </div>
    <Field label="Blocked by" htmlFor={`${id}-blocker`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {(task.blockedBy ?? []).map(blockerId => {
          const blocker = byId.get(blockerId);
          const done = blocker?.status === "completed";
          return <span key={blockerId} className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-border pl-2 pr-0.5 text-xs">
            <Icon name={done ? "CircleCheck" : blocker ? "Circle" : "CircleX"} className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className={cn("truncate", done && "text-muted-foreground line-through")} title={blocker?.subject}>
              #{blockerId}{blocker ? ` ${blocker.subject}` : " (deleted)"}
            </span>
            <button type="button" className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={`Remove blocker #${blockerId}`} onClick={() => update({ removeBlockedBy: [blockerId] })}>
              <Icon name="CircleX" className="size-3" aria-hidden="true" />
            </button>
          </span>;
        })}
        {candidates.length > 0 && <select id={`${id}-blocker`} aria-label={`Add blocker for #${task.id}`} value=""
          className={cn(FIELD, "h-6 w-auto max-w-56 cursor-pointer rounded-full pr-1 text-muted-foreground")}
          onChange={event => { const value = Number(event.target.value); if (value) update({ addBlockedBy: [value] }); }}>
          <option value="">Add blocker…</option>
          {candidates.map(other => <option key={other.id} value={other.id}>#{other.id} {other.subject}</option>)}
        </select>}
        {!task.blockedBy?.length && !candidates.length && <span className="text-xs text-muted-foreground">No other todos</span>}
      </div>
    </Field>
    {node.blocks.length > 0 && <p className="text-2xs text-muted-foreground">
      Blocks {node.blocks.map(blockedId => `#${blockedId}`).join(", ")}
    </p>}
  </div>;
}

function TaskItem({ node, view, mutate, running, expanded, toggle }: {
  node: EditorNode; view: ReturnType<typeof buildEditorView>; mutate: Mutate; running: boolean;
  expanded: ReadonlySet<number>; toggle: (id: number) => void;
}) {
  const { task } = node;
  const detailsId = `${useId()}-details`;
  const open = expanded.has(task.id);
  const done = task.status === "completed";
  const shortcuts = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const command = structuralShortcut(event);
    const change = command && structuralChange(node, command);
    if (!change) return;
    event.preventDefault();
    // Nesting remounts the row under its new parent, so refocus by id rather than by element.
    const panel = event.currentTarget.closest("section");
    void mutate(change).then(() => requestAnimationFrame(() => {
      panel?.querySelector<HTMLInputElement>(`[data-subject-for="${task.id}"]`)?.focus();
    }));
  };
  return <li className="min-w-0 list-none" data-task-id={task.id} data-status={task.status}>
    <div className={cn("group/row flex min-h-8 items-center gap-1 rounded-md pl-1 pr-0.5 hover:bg-state-hover/60 focus-within:bg-state-hover/60",
      task.status === "in_progress" && "bg-state-hover/40")}>
      <StatusControl node={node} mutate={mutate} running={running} />
      {view.isOrdered ? <span className="todo-editor-marker inline-flex w-6 shrink-0 items-center justify-end text-right text-2xs tabular-nums text-muted-foreground" aria-hidden="true">
        <span className="todo-editor-number inline-flex items-center justify-end"><span className="todo-editor-number-value">{task.status === "in_progress"
          ? <Icon name="Spinner" className={cn("size-3", running && "animate-spin")} />
          : node.ordinal}</span><span className="todo-editor-period">.</span></span>
      </span> : <span className="todo-editor-marker todo-editor-marker-unordered inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
        <Icon name={statusIcon(node)} className={cn("size-3.5", task.status === "in_progress" && running && "animate-spin")} />
      </span>}
      <CommitField aria-label={`Subject for #${task.id}`} data-subject-for={task.id} aria-keyshortcuts={SHORTCUT_ARIA}
        value={task.subject} required onKeyDown={shortcuts}
        onCommit={subject => { void mutate({ action: "update", id: task.id, subject }); }}
        className={cn("h-7 min-w-0 flex-1 text-ellipsis rounded-sm bg-transparent px-1.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring",
          done ? "text-muted-foreground line-through decoration-muted-foreground/60" : "text-foreground",
          task.status === "in_progress" && "font-medium")} />
      {node.waitingOn.length > 0 && <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-1.5 text-2xs tabular-nums text-muted-foreground"
        title={`Depends on ${node.waitingOn.map(id => `${findEditorNode(view.roots, id)?.ordinal ?? id}. ${view.ordered.find(task => task.id === id)?.subject ?? ""}`).join(", ")}`}>
        depends on {node.waitingOn.map(id => findEditorNode(view.roots, id)?.ordinal ?? id).join(", ")}
      </span>}
      {task.owner && <span className="hidden h-5 max-w-24 shrink-0 items-center truncate rounded-full bg-muted px-1.5 text-2xs text-muted-foreground sm:inline-flex" title={`Owner: ${task.owner}`}>{task.owner}</span>}
      <button type="button" className={ICON_BUTTON} aria-expanded={open} aria-controls={open ? detailsId : undefined}
        aria-label={`${open ? "Hide" : "Show"} details for #${task.id}`} onClick={() => toggle(task.id)}>
        <Icon name="ChevronDown" aria-hidden="true" className={cn("transition-transform duration-150", !open && "-rotate-90")} />
      </button>
      <RowMenu node={node} mutate={mutate} />
    </div>
    {!open && task.description && <p className="-mt-1 mb-1 truncate pl-[4.125rem] pr-16 text-xs text-muted-foreground" title={task.description}>{task.description}</p>}
    {open && <TaskDetails node={node} view={view} mutate={mutate} id={detailsId} />}
    {node.children.length > 0 && <ul className="ml-[0.9375rem] border-l border-border pl-2" aria-label={`Subtasks of #${task.id}`}>
      {node.children.map(child => <TaskItem key={child.task.id} node={child} view={view} mutate={mutate} running={running} expanded={expanded} toggle={toggle} />)}
    </ul>}
  </li>;
}

function ClearAll({ count, onConfirm }: { count: number; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger className={ICON_BUTTON} aria-label="List actions"><Icon name="MoreHorizontal" aria-hidden="true" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" mobileTitle="Todos" className="min-w-40">
        <DropdownMenuLabel className="text-2xs font-normal text-muted-foreground">This thread's todos</DropdownMenuLabel>
        <DropdownMenuItem variant="destructive" disabled={count === 0} onSelect={() => setOpen(true)}>
          <Icon name="Trash2" aria-hidden="true" />Clear all…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base">Clear all todos?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes {count === 1 ? "the 1 todo" : `all ${count} todos`} from this thread and restarts numbering at #1. It can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={onConfirm}>Clear all</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

/**
 * The Todos thread panel: the full editable list for one thread. It edits the
 * same reducer state the agent's `todo` tool does, so every change here is
 * validated by the server and appears in the composer card immediately.
 */
export function TodoEditor({ threadId }: Pick<PluginThreadPanelProps, "threadId">) {
  const { state, loaded, error, mutate, dismissError } = useTodoList(threadId);
  const composer = useComposer();
  const view = useMemo(() => buildEditorView(state.tasks), [state.tasks]);
  const [subject, setSubject] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const addRef = useRef<HTMLInputElement>(null);
  const toggle = (id: number) => setExpanded(current => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const add = async () => {
    if (!subject.trim()) return;
    if (await mutate({ action: "create", subject: subject.trim() })) setSubject("");
    addRef.current?.focus();
  };
  const activeCount = view.ordered.filter(task => task.status === "in_progress").length;
  const summary = view.completed === view.total ? `All ${view.total} complete` : `${view.completed} of ${view.total} complete`;
  return <section aria-label="Todos" className="flex h-full min-h-0 flex-col text-foreground">
    {view.total > 0 && <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
      {view.completed === view.total
        ? <Icon name="CircleCheck" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        : <ProgressRing completed={view.completed} total={view.total} className="size-3.5 shrink-0 text-muted-foreground" />}
      <p className="min-w-0 flex-1 truncate text-xs" role="status">
        <span className="font-medium">{summary}</span>
        {view.current && <span className="text-muted-foreground"> · {activeCount > 1 ? `${activeCount} todos in progress` : view.current.activeForm?.trim() || view.current.subject}</span>}
      </p>
      <ClearAll count={view.total} onConfirm={() => { void mutate({ action: "clear" }); setExpanded(new Set()); }} />
    </header>}
    {error && <div role="alert" className="flex shrink-0 items-start gap-2 border-b border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive-text">
      <Icon name="AlertCircle" className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{error}</span>
      <button type="button" className="shrink-0 cursor-pointer underline-offset-2 hover:underline" onClick={dismissError}>Dismiss</button>
    </div>}
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      {view.total > 0
        ? <ul aria-label="Todo list" className="min-w-0">
          {view.roots.map(node => <TaskItem key={node.task.id} node={node} view={view} mutate={mutate} running={composer.isRunning} expanded={expanded} toggle={toggle} />)}
        </ul>
        : loaded && <div className="mx-auto flex max-w-64 flex-col items-center gap-1.5 px-4 py-10 text-center">
          <Icon name="ListTodo" className="mb-1 size-5 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">No todos in this thread</p>
          <p className="text-xs text-muted-foreground">Agents list their steps here for multi-step work. Add your own below.</p>
        </div>}
    </div>
    <form className="flex shrink-0 items-center gap-1 border-t border-border p-2" onSubmit={event => { event.preventDefault(); void add(); }}>
      <Icon name="Plus" className="ml-1.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input ref={addRef} aria-label="New todo" placeholder="Add a todo" value={subject} onChange={event => setSubject(event.target.value)}
        className="h-8 min-w-0 flex-1 rounded-sm bg-transparent px-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring" />
      <Button type="submit" size="sm" variant="ghost" className="h-7 px-2.5" disabled={!subject.trim()}>Add</Button>
    </form>
  </section>;
}
