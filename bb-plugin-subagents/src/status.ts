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

export function stripModelBrandPrefix(label: string, brandPrefix?: string): string {
  if (!brandPrefix) return label;
  return label.toLowerCase().startsWith(brandPrefix.toLowerCase())
    ? label.slice(brandPrefix.length).trimStart()
    : label;
}

export function splitModelLabelTag(label: string): { base: string; tag: string | null } {
  const match = label.match(/^(.*\S)\s*\(([^()]+)\)$/u);
  if (!match) return { base: label, tag: null };
  return { base: match[1]!, tag: match[2]! };
}

/**
 * Formats a model identifier or display name the way BB's model picker trigger
 * shows it (for example "gpt-6.1-sol" -> "GPT-6.1 Sol", "claude-opus-4-6" -> "Claude Opus 4.6").
 */
export function formatModelDisplayName(
  model: string | null | undefined,
  brandPrefix?: string,
): string {
  const raw = model?.trim();
  if (!raw) return "Default model";
  if (raw.includes(" ")) return stripModelBrandPrefix(raw, brandPrefix);
  const slug = raw.split("/").pop() || raw;
  const parts = slug.split("-");
  const formattedParts = parts.map(part => {
    if (part.toLowerCase() === "gpt") return "GPT";
    if (/^\d+(\.\d+)*$/.test(part)) return part;
    if (/^[a-z]\d+(\.\d+)*$/i.test(part)) return part.toUpperCase();
    if (/^[a-z]+$/i.test(part)) {
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }
    return part;
  });

  // Join "GPT" + version with a hyphen ("GPT-6.1 Sol", "GPT-5.4"), and join
  // trailing numeric version segments on Claude/other models with "." ("Claude Opus 4.6").
  const tokens: string[] = [];
  for (let i = 0; i < formattedParts.length; i++) {
    const current = formattedParts[i]!;
    const prev = tokens[tokens.length - 1];
    if (prev === "GPT" && /^\d/.test(current)) {
      tokens[tokens.length - 1] = `GPT-${current}`;
    } else if (prev && /^\d+$/.test(prev) && /^\d+$/.test(current)) {
      tokens[tokens.length - 1] = `${prev}.${current}`;
    } else {
      tokens.push(current);
    }
  }
  return stripModelBrandPrefix(tokens.join(" "), brandPrefix);
}

const STANDARD_REASONING_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultracode: "Ultracode",
  max: "Max",
  ultra: "Ultra",
};

export function reasoningLevelLabel(
  level: string | null | undefined,
  declaredLevels?: readonly { id: string; label?: string }[],
  effortLabel?: string,
): string | null {
  const raw = level?.trim();
  if (!raw) return null;
  if (effortLabel) return effortLabel;
  const declared = declaredLevels?.find(option => option.id === raw);
  if (declared?.label) return declared.label;
  const standard = STANDARD_REASONING_LABELS[raw.toLowerCase()];
  if (standard) return standard;
  const words = raw.split(/[\s_-]+/u).filter(Boolean);
  return words.length === 0
    ? raw
    : words.map(word => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
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
