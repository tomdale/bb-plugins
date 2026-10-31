// What the empty right margin of the introduction and the wrap-up holds on a
// wide page: the introduction says how to read, and the wrap-up lists what is
// still open, each item a note in the margin that jumps to its place.
import { formatLocation, NOTE_KIND_LABEL } from "../model.ts";
import type { DeliveredNote as Note } from "../schemas.ts";
import { ellipsize } from "./highlight.ts";

const SHOWN = 5;

/** How to read: the three gestures a first-time reader would otherwise have to discover. */
export function ReadingMargin() {
  return (
    <aside className="wt-aside" aria-label="How to read">
      <p className="wt-lbl">Reading</p>
      <p className="wt-aside-line">
        Select text, or press a line number, to flag it.
      </p>
      <p className="wt-aside-line">
        <kbd>←</kbd> <kbd>→</kbd> turn the pages.
      </p>
      <p className="wt-aside-line">
        <kbd>/</kbd> goes to the question box.
      </p>
    </aside>
  );
}

/** The wrap-up's open items as marginalia: the reader's own flags, newest last, each a button that goes to its place. */
export function OpenMargin({ notes, glyphs, onJump, onMore }: { notes: Note[]; glyphs: Map<string, string>; onJump: (note: Note) => void; onMore: () => void }) {
  if (notes.length === 0) return null;
  return (
    <aside className="wt-aside" aria-label="Still open">
      <p className="wt-lbl">Still open</p>
      {notes.slice(0, SHOWN).map((note) => (
        <button key={note.id} type="button" className="wt-mn wt-aside-item" onClick={() => onJump(note)}>
          <span className="wt-m wt-m-own wt-m-inline" aria-hidden>
            {glyphs.get(note.id) ?? "•"}
          </span>
          <span className="wt-mn-kind">{NOTE_KIND_LABEL[note.kind]} · </span>
          {ellipsize(note.text, 110)}
          {note.location ? <span className="wt-aside-loc">{formatLocation(note.location)}</span> : null}
        </button>
      ))}
      {notes.length > SHOWN ? (
        <button type="button" className="wt-link-btn" onClick={onMore}>
          and {notes.length - SHOWN} more
        </button>
      ) : null}
    </aside>
  );
}
