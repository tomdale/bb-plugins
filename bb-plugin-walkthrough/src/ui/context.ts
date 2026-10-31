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

export const ReaderContext = createContext<ReaderContextValue>({ glyphs: new Map(), canComment: false, commentReason: "Comments are for pull requests" });
