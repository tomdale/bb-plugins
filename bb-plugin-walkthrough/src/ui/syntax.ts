// Syntax tokens for a figure's rows. The page never tokenizes: it sends the
// figure's code to the plugin's `highlight` RPC (src/syntax/tokenizer.ts) and
// gets role-tagged lines back, which the rows render as spans.
//
// Context decides the tokens. Added and context lines are read as the file's
// new text and removed lines as its old text, each side tokenized whole, so a
// template string or block comment that spans lines is coloured on every line.
// Hunks are tokenized apart: lines skipped between them could change the state.
import { useEffect, useState } from "react";
import { languageFor } from "../syntax/languages.ts";
import { MAX_TEXT } from "../syntax/limits.ts";
import type { LineTokens } from "../syntax/roles.ts";
import type { PatchRow } from "./patch-lines.ts";
import type { WalkthroughRpc } from "./hooks.ts";

/** One run of rows that is read as continuous text, and the rows whose tokens it supplies. */
export interface Chunk {
  text: string;
  /** Row indexes, one per line of `text`; null for a line that is read for state but whose tokens the row does not use. */
  rows: Array<number | null>;
}

/**
 * The texts to tokenize for `rows`: the new side (context and added lines) and,
 * only where something was removed, the old side. Context rows take their
 * tokens from the new side, so the old side contributes removed lines alone.
 */
export function chunksFor(rows: PatchRow[]): Chunk[] {
  const chunks: Chunk[] = [];
  const hasRemoved = rows.some((row) => row.kind === "del");
  let after: Chunk | null = null;
  let before: Chunk | null = null;
  const flush = () => {
    if (after) chunks.push(after);
    if (before && before.rows.some((row) => row !== null)) chunks.push(before);
    after = before = null;
  };
  const push = (chunk: Chunk, row: PatchRow, index: number, use: boolean) => {
    chunk.rows.push(use ? index : null);
    chunk.text += chunk.rows.length > 1 ? `\n${row.text}` : row.text;
  };
  rows.forEach((row, index) => {
    if (row.kind === "gap") return flush();
    after ??= { text: "", rows: [] };
    if (hasRemoved) before ??= { text: "", rows: [] };
    if (row.kind !== "del") push(after, row, index, true);
    if (before && row.kind !== "add") push(before, row, index, row.kind === "del");
  });
  flush();
  return chunks.filter((chunk) => chunk.rows.length > 0 && chunk.text.length <= MAX_TEXT);
}

/** Tokens by row index. */
export type RowTokens = ReadonlyMap<number, LineTokens>;

const CACHE_LIMIT = 80;
const settled = new Map<string, RowTokens | null>();
const pending = new Map<string, Promise<RowTokens | null>>();

/** A short hash of the chunks' text, so a key changes with the code and an unchanged figure is found again. */
function fingerprint(chunks: Chunk[]): string {
  let hash = 0x811c9dc5;
  for (const chunk of chunks) {
    for (let at = 0; at < chunk.text.length; at += 1) hash = Math.imul(hash ^ chunk.text.charCodeAt(at), 0x01000193);
    hash = Math.imul(hash ^ 0x0a, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Where a figure's tokens are remembered: its file, the revision it was read
 * at, its line range and view, plus a fingerprint of the code itself. A
 * walkthrough read at one revision shows the same tokens however often its
 * figures remount; code with no revision (the working tree) is still told apart
 * by the fingerprint.
 */
export function tokenKey(path: string, revision: string | null, range: string, view: string, chunks: Chunk[]): string {
  return [path, revision ?? "", range, view, fingerprint(chunks)].join("\u0000");
}

function remember(key: string, tokens: RowTokens | null) {
  settled.set(key, tokens);
  if (settled.size > CACHE_LIMIT) settled.delete(settled.keys().next().value!);
}

/** Tokens already known for `key`, without asking; `undefined` when not yet loaded. */
export const knownTokens = (key: string): RowTokens | null | undefined => settled.get(key);
export const forgetTokens = () => {
  settled.clear();
  pending.clear();
};

/** Asks the server for the tokens of `chunks` and spreads them over the rows. Resolves to null when nothing is highlightable; never rejects. */
export function loadTokens(rpc: WalkthroughRpc, key: string, path: string, chunks: Chunk[]): Promise<RowTokens | null> {
  if (settled.has(key)) return Promise.resolve(settled.get(key)!);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const request = rpc
    .call("highlight", { path, texts: chunks.map((chunk) => chunk.text) })
    .then((result): RowTokens | null => {
      const tokens = new Map<number, LineTokens>();
      chunks.forEach((chunk, at) => {
        const lines = result.texts[at];
        if (!lines) return;
        chunk.rows.forEach((row, line) => {
          const found = lines[line];
          if (row !== null && found && found.length > 0) tokens.set(row, found);
        });
      });
      return tokens.size > 0 ? tokens : null;
    })
    .catch(() => null)
    .then((tokens) => {
      pending.delete(key);
      remember(key, tokens);
      return tokens;
    });
  pending.set(key, request);
  return request;
}

/**
 * The tokens for a figure's rows. They arrive after first paint (the rows are
 * plain until then, and colour is all that changes), come from memory when the
 * figure has been shown before, and never arrive while `enabled` is false: a
 * figure that is still being written stays plain until it is complete.
 */
export function useRowTokens(rpc: WalkthroughRpc, options: { enabled: boolean; path: string; revision: string | null; range: string; view: string; rows: PatchRow[]; chunks: Chunk[] }): RowTokens | null {
  const { enabled, path, revision, range, view, rows, chunks } = options;
  const supported = enabled && rows.length > 0 && chunks.length > 0 && languageFor(path) !== null;
  const key = supported ? tokenKey(path, revision, range, view, chunks) : null;
  const [loaded, setLoaded] = useState<{ key: string; tokens: RowTokens | null } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    void loadTokens(rpc, key, path, chunks).then((tokens) => live && setLoaded({ key, tokens }));
    return () => {
      live = false;
    };
    // `key` already stands for the content of `chunks`.
  }, [rpc, key, path]);
  if (key === null) return null;
  const known = knownTokens(key);
  if (known !== undefined) return known;
  return loaded?.key === key ? loaded.tokens : null;
}
