import { experimental_Icon as Icon, useBbNavigate, type PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils.js";
import { buttonVariants } from "./components/ui/button.js";
import { useTodoList } from "./use-todos.js";

export const TODO_PANEL_ACTION_ID = "todos";

/**
 * The thread header's Todos control: an icon that opens the Todos panel, with
 * the completion count beside it once the thread has todos. It matches the
 * 28px ghost controls around it in the header row.
 */
export function TodoEditorButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const { state } = useTodoList(threadId);
  const visible = state.tasks.filter(task => task.status !== "deleted");
  const completed = visible.filter(task => task.status === "completed").length;
  const showCount = visible.length > 0 && !isCompactViewport;
  const label = visible.length ? `Open Todos, ${completed} of ${visible.length} complete` : "Open Todos";
  return <button type="button" aria-label={label} title="Todos"
    className={cn(buttonVariants({ variant: "ghost" }), "h-7 gap-1.5 text-xs text-muted-foreground", showCount ? "px-2" : "w-7 px-0")}
    onClick={() => { navigate.openThreadPanel({ actionId: TODO_PANEL_ACTION_ID }); }}>
    <Icon name="ListTodo" className="size-4" aria-hidden="true" />
    {showCount && <span className="tabular-nums">{completed}/{visible.length}</span>}
  </button>;
}
