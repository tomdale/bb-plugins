// A unified patch as numbered rows, so the figure can draw its own gutter and
// put note markers in it.
export interface PatchRow {
  kind: "add" | "del" | "ctx" | "gap";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/** Rows of every hunk in `patch`; a `gap` row stands where lines were skipped between hunks. */
export function parsePatchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      const nextOld = Number(hunk[1]);
      const nextNew = Number(hunk[2]);
      if (inHunk && (nextNew > newNo || nextOld > oldNo)) rows.push({ kind: "gap", oldNo: null, newNo: null, text: "" });
      oldNo = nextOld;
      newNo = nextNew;
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git")) {
      inHunk = false;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    const marker = line[0];
    const text = line.slice(1);
    if (marker === "+") rows.push({ kind: "add", oldNo: null, newNo: newNo++, text });
    else if (marker === "-") rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text });
    else if (marker === " ") rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text });
  }
  return rows;
}

/** Index of the row a file line number belongs to (new side first, then old), or the nearest row. */
export function rowIndexForLine(rows: PatchRow[], line: number): number {
  const exact = rows.findIndex((row) => row.newNo === line) >= 0 ? rows.findIndex((row) => row.newNo === line) : rows.findIndex((row) => row.oldNo === line);
  if (exact >= 0) return exact;
  let best = 0;
  let distance = Infinity;
  rows.forEach((row, index) => {
    const number = row.newNo ?? row.oldNo;
    if (number === null) return;
    const away = Math.abs(number - line);
    if (away < distance) {
      distance = away;
      best = index;
    }
  });
  return best;
}
