import { createContext } from "react";

/** What the figures and pages under a reader need from it, so it is not threaded through every prop. */
export interface ReaderContextValue {
  /** The marker each reader flag wears, by note id (see `flagGlyphs`). */
  glyphs: Map<string, string>;
  /** Whether line flags can become review comments (a PR walkthrough). */
  canComment: boolean;
  /** Why a Comment cannot be offered, shown beside the disabled option. */
  commentReason: string;
}

/**
 * The reader's own box. Tooltips, menus and the part picker portal out of it,
 * so they would otherwise collide with the window's edge and land over the
 * sidebar; they are asked to stay inside the plugin's pane instead.
 */
export const BoundaryContext = createContext<Element[]>([]);

export const ReaderContext = createContext<ReaderContextValue>({ glyphs: new Map(), canComment: false, commentReason: "Comments are for pull requests" });
