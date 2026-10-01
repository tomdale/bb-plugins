import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import type { Input, State, Task } from "./model.js";

export function TodoEditor({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<State>({ tasks: [], nextId: 1 });
  const [subject, setSubject] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    rpc.call("snapshot", { threadId }).then(setState, cause => setError(String(cause)));
  }, [rpc, threadId]);
  useEffect(() => { refresh(); }, [refresh]);
  useRealtime("todo-changed", payload => {
    if (payload && typeof payload === "object" && "threadId" in payload && payload.threadId === threadId) refresh();
  });
  const mutate = async (change: Input): Promise<boolean> => {
    try {
      const next = await rpc.call("mutate", { threadId, change });
      setState(next);
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };
  const visible = state.tasks.filter(task => task.status !== "deleted");
  const visibleIds = new Set(visible.map(task => task.id));
  const children = (parentId?: number): Task[] => visible.filter(task => (visibleIds.has(task.parentId!) ? task.parentId : undefined) === parentId);
  const render = (parentId?: number, depth = 0): React.ReactNode => children(parentId).map(task => <li key={task.id} style={{ paddingLeft: `${depth * 16}px` }}>
    <span>#{task.id} </span>
    <input aria-label={`Subject for #${task.id}`} defaultValue={task.subject} key={`${task.id}:${task.subject}`}
      onBlur={event => { if (event.target.value !== task.subject) void mutate({ action: "update", id: task.id, subject: event.target.value }); }} />
    <select aria-label={`Status for #${task.id}`} value={task.status}
      onChange={event => void mutate({ action: "update", id: task.id, status: event.target.value as Task["status"] })}>
      <option value="pending">Pending</option><option value="in_progress">In progress</option><option value="completed">Completed</option>
    </select>
    <button type="button" aria-label={`Move #${task.id} up`} onClick={() => void mutate({ action: "update", id: task.id, move: "up" })}>↑</button>
    <button type="button" aria-label={`Move #${task.id} down`} onClick={() => void mutate({ action: "update", id: task.id, move: "down" })}>↓</button>
    <button type="button" aria-label={`Indent #${task.id}`} disabled={children(parentId).findIndex(sibling => sibling.id === task.id) < 1}
      onClick={() => { const siblings = children(parentId); const previous = siblings[siblings.findIndex(sibling => sibling.id === task.id) - 1]; if (previous) void mutate({ action: "update", id: task.id, parentId: previous.id }); }}>→</button>
    <button type="button" aria-label={`Outdent #${task.id}`} disabled={parentId === undefined}
      onClick={() => void mutate({ action: "update", id: task.id, parentId: state.tasks.find(parent => parent.id === parentId)?.parentId ?? null })}>←</button>
    <button type="button" aria-label={`Delete #${task.id}`} onClick={() => void mutate({ action: "delete", id: task.id })}>Delete</button>
    <details><summary>Details and dependencies</summary>
      <label>Description <textarea defaultValue={task.description ?? ""} key={`${task.id}:description:${task.description ?? ""}`}
        onBlur={event => { if (event.target.value !== (task.description ?? "")) void mutate({ action: "update", id: task.id, description: event.target.value }); }} /></label>
      <label>Working label <input defaultValue={task.activeForm ?? ""} key={`${task.id}:activeForm:${task.activeForm ?? ""}`}
        onBlur={event => { if (event.target.value !== (task.activeForm ?? "")) void mutate({ action: "update", id: task.id, activeForm: event.target.value }); }} /></label>
      <label>Owner <input defaultValue={task.owner ?? ""} key={`${task.id}:owner:${task.owner ?? ""}`}
        onBlur={event => { if (event.target.value !== (task.owner ?? "")) void mutate({ action: "update", id: task.id, owner: event.target.value }); }} /></label>
      <label>Blocked by <select aria-label={`Blocker for #${task.id}`} defaultValue=""
        onChange={event => { if (event.target.value) void mutate({ action: "update", id: task.id, addBlockedBy: [Number(event.target.value)] }); event.target.value = ""; }}>
        <option value="">Add dependency…</option>
        {visible.filter(other => other.id !== task.id && !task.blockedBy?.includes(other.id)).map(other => <option key={other.id} value={other.id}>#{other.id} {other.subject}</option>)}
      </select></label>
      {task.blockedBy?.map(id => <button key={id} type="button" onClick={() => void mutate({ action: "update", id: task.id, removeBlockedBy: [id] })}>Remove blocker #{id}</button>)}
    </details>
    <ul>{render(task.id, depth + 1)}</ul>
  </li>);
  return <section aria-label="Todo editor">
    <h2>Todos</h2>
    {error && <p role="alert">{error}</p>}
    <ul>{render()}</ul>
    <form onSubmit={event => { event.preventDefault(); if (!subject.trim()) return; void mutate({ action: "create", subject }).then(success => { if (success) setSubject(""); }); }}>
      <input aria-label="New todo" value={subject} onChange={event => setSubject(event.target.value)} />
      <button type="submit">Add todo</button>
    </form>
    <button type="button" onClick={() => { if (window.confirm("Clear every todo in this thread?")) void mutate({ action: "clear" }); }}>Clear all</button>
  </section>;
}
