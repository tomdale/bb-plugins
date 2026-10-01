import type { Entry } from "../contracts.js";

export type InventoryFilter = "all" | "workspaces" | "worktrees" | "attention";
export type InventorySort = "recent" | "name";
export function needsAttention(entry: Entry) {
  return entry.state !== "ready";
}
export function groupInventory(
  entries: Entry[],
  query: string,
  filter: InventoryFilter,
  sort: InventorySort,
) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matching = entries.filter((entry) => {
    if (filter === "workspaces" && entry.type === "worktree") return false;
    if (filter === "worktrees" && entry.type !== "worktree") return false;
    if (filter === "attention" && !needsAttention(entry)) return false;
    const text = [entry.selector, entry.path, ...(entry.repos ?? [])]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const groups = new Map<
    string,
    { id: string; name: string; kind: string; entries: Entry[] }
  >();
  for (const entry of matching) {
    const kind = entry.type === "worktree" ? "Repository" : "Workspace";
    const id = `${kind}:${entry.groupName}`;
    const group = groups.get(id) ?? {
      id,
      name:
        entry.groupName === "_adhoc" ? "Ad hoc workspaces" : entry.groupName,
      kind,
      entries: [],
    };
    group.entries.push(entry);
    groups.set(id, group);
  }
  const compare = (a: Entry, b: Entry) =>
    sort === "recent"
      ? b.modifiedAtMs - a.modifiedAtMs || a.selector.localeCompare(b.selector)
      : a.changeName.localeCompare(b.changeName);
  return [...groups.values()]
    .map((group) => ({ ...group, entries: group.entries.sort(compare) }))
    .sort((a, b) =>
      sort === "recent"
        ? b.entries[0]!.modifiedAtMs - a.entries[0]!.modifiedAtMs ||
          a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name),
    );
}
export function relativeUpdated(timestamp: number, now = Date.now()) {
  const days = Math.floor(Math.max(0, now - timestamp) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
