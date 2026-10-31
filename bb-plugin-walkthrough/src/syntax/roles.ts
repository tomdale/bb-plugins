// The semantic roles a figure's code is painted in, and the wire shape of a
// tokenized line. The server decides each token's role from the grammar's
// scopes; the page decides what colour a role is (app.css, `--wt-tk-*`), so a
// token never carries a colour and the palette can follow light, dark and
// increased contrast without retokenizing.

/** Nine roles, deliberately few: a page of code reads as prose with a few inks, not a rainbow. */
export const ROLES = ["keyword", "string", "number", "comment", "function", "type", "property", "punctuation", "heading"] as const;
export type Role = (typeof ROLES)[number];

/** One painted stretch of a line, as `[start, end)` UTF-16 offsets into the line's text. Text between tokens is plain. */
export type LineToken = [start: number, end: number, role: Role];
export type LineTokens = LineToken[];

/** The language of a path and the tokens of each text sent for it; `language` is null (and `texts` all null) when the path has no grammar here. */
export interface Highlighted {
  language: string | null;
  texts: Array<LineTokens[] | null>;
}
