import type { Run } from "./contracts.ts";

/** A run that is still doing background work. */
export function runIsWorking(run: Pick<Run, "status">): boolean {
  return run.status === "starting" || run.status === "running";
}

export function runStatusLabel(run: Pick<Run, "status">): string {
  switch (run.status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "killed":
      return "Stopped";
    case "timed-out":
      return "Timed out";
  }
}

export function runStatusGlyph(run: Pick<Run, "status">): string {
  switch (run.status) {
    case "starting":
      return "◌";
    case "running":
      return "↻";
    case "completed":
      return "✓";
    case "failed":
    case "timed-out":
      return "✕";
    case "killed":
      return "■";
  }
}

/**
 * Row state note shown only when the group heading + glyph do not already state
 * the exact condition (Starting in Active; Failed, Stopped, or Timed out in Inactive).
 */
export function runStateNote(run: Pick<Run, "status">): string {
  switch (run.status) {
    case "starting":
      return "Starting";
    case "failed":
      return "Failed";
    case "killed":
      return "Stopped";
    case "timed-out":
      return "Timed out";
    case "running":
    case "completed":
      return "";
  }
}

const KNOWN_PROVIDERS: Readonly<Record<string, string>> = {
  pi: "Pi",
  codex: "Codex",
  "claude-code": "Claude Code",
  acp: "ACP",
  fx: "FX",
};

export function providerLabel(providerId: string | null | undefined): string {
  if (!providerId) return "Default provider";
  return KNOWN_PROVIDERS[providerId] ?? providerId;
}

export function modelLabel(model: string | null | undefined): string {
  if (!model) return "default model";
  const parts = model.split("/");
  return parts[parts.length - 1] || model;
}

export function thinkingLabel(reasoningLevel: string | null | undefined): string {
  const level = reasoningLevel?.trim() || "default";
  return `thinking: ${level}`;
}

/**
 * Extracts a clean one-sentence plain-text summary (at most 160 chars) from
 * assistant output or a task prompt, stripping reply wrappers, code fences,
 * and Markdown headings.
 */
export function extractOneSentenceSummary(text: string, fallback = "Working in the background."): string {
  const stripped = text
    .replace(/^:{3,}reply[^\n]*$/gm, "")
    .replace(/^:{3,}$/gm, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return fallback;
  const sentences = stripped.match(/[^.!?]+[.!?]+/g);
  const candidate = (sentences ? sentences[sentences.length - 1]! : stripped).trim();
  if (!candidate) return fallback;
  const max = 160;
  const clipped = candidate.length > max ? `${candidate.slice(0, max - 1).trimEnd()}…` : candidate;
  return /[.!?…]$/.test(clipped) ? clipped : `${clipped}.`;
}

export interface RunTreeNode {
  run: Run;
  children: RunTreeNode[];
}

export function subtreeIsActive(node: RunTreeNode): boolean {
  if (runIsWorking(node.run)) return true;
  return node.children.some(subtreeIsActive);
}

/**
 * Reconstructs parent -> child trees from `ownerThreadId` and `threadId`,
 * ordering siblings newest-first, and groups root trees into Active (any node
 * in the subtree is working) followed by Inactive (all nodes in the subtree settled).
 */
export function buildRunTrees(runs: readonly Run[]): {
  activeTrees: RunTreeNode[];
  inactiveTrees: RunTreeNode[];
  parentById: Map<string, Run>;
  childrenById: Map<string, Run[]>;
} {
  const ordered = [...runs].sort((a, b) => b.createdAt - a.createdAt);
  const byThreadId = new Map<string, Run>();
  for (const run of ordered) {
    if (run.threadId) byThreadId.set(run.threadId, run);
  }
  const parentById = new Map<string, Run>();
  const childrenById = new Map<string, Run[]>();
  const roots: Run[] = [];

  for (const run of ordered) {
    const parent = byThreadId.get(run.ownerThreadId);
    if (parent && parent.id !== run.id) {
      parentById.set(run.id, parent);
      const list = childrenById.get(parent.id) ?? [];
      list.push(run);
      childrenById.set(parent.id, list);
    } else {
      roots.push(run);
    }
  }

  const visited = new Set<string>();
  const buildNode = (run: Run): RunTreeNode => {
    visited.add(run.id);
    const kids = (childrenById.get(run.id) ?? []).filter(child => !visited.has(child.id));
    return { run, children: kids.map(buildNode) };
  };

  const rootNodes = roots.map(buildNode);
  for (const run of ordered) {
    if (!visited.has(run.id)) rootNodes.push(buildNode(run));
  }

  const activeTrees = rootNodes.filter(subtreeIsActive);
  const inactiveTrees = rootNodes.filter(node => !subtreeIsActive(node));
  return { activeTrees, inactiveTrees, parentById, childrenById };
}

export interface RunSummary {
  /** Working runs the agent controls. */
  working: number;
  /** Runs that ended in failure, kill, or timeout. */
  failed: number;
  /** Runs that ended successfully. */
  settled: number;
}

export function summarizeRuns(runs: readonly Pick<Run, "status">[]): RunSummary {
  const summary: RunSummary = { working: 0, failed: 0, settled: 0 };
  for (const run of runs) {
    if (runIsWorking(run)) summary.working++;
    else if (run.status === "completed") summary.settled++;
    else summary.failed++;
  }
  return summary;
}

/** One short count line, omitting zeros, for the header action's label. */
export function summaryLine(summary: RunSummary): string {
  const parts: string[] = [];
  if (summary.working > 0) parts.push(`${summary.working} running`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.settled > 0) parts.push(`${summary.settled} completed`);
  return parts.join(" · ");
}
