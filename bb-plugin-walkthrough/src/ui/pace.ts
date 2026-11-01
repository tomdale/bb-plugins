// Paces the reveal of streamed text on the reader's screen.
//
// A provider may hold its first words for seconds and then deliver them as one
// lump (a two-kilobyte first delta is common from a model that thinks first);
// after that, text trickles in at the model's own pace. The tail publishes the
// lump the moment it sees it, so left alone the pane shows a whole introduction
// at once, then nothing. The pacer reveals a lump over about LAG_MS instead.
//
// The received text stays the only source of truth: the pacer only chooses how
// long a prefix of it is shown. Small steps (the normal trickle) are shown
// shown at once, so a stream that already flows is not slowed; a step of
// LUMP_MIN characters or more takes up to LAG_MS to reveal, at a constant
// speed. Text that arrives behind a lump waits for the lump's deadline rather
// than overtaking it, so nothing is ever more than LAG_MS behind the received
// text.
import type { StreamPayload } from "../schemas.ts";

/** Longest a lump may take to appear, and so the most the display may trail the received text. */
export const LAG_MS = 1200;
/** Smallest single step that counts as a lump rather than the normal trickle. */
export const LUMP_MIN = 120;

interface Pending {
  /** Length of the received text this step starts and ends at. */
  start: number;
  end: number;
  /** When the step must be fully shown. */
  due: number;
  /** Text the pane does not show while the text before it is still being revealed: it costs no time. */
  free: boolean;
}

/** The paced reveal of one stream's text. Times are milliseconds on any one clock. */
export class TextPacer {
  private received = 0;
  private shownLength = 0;
  private pending: Pending[] = [];
  private lastAt = 0;

  /** Characters of the received text to show now. */
  get shown(): number {
    return this.shownLength;
  }

  /** True while some received text is not shown yet. */
  get busy(): boolean {
    return this.shownLength < this.received;
  }

  /**
   * Takes the full text received so far. `instant` shows all of it at once: the
   * pane just opened on a message already under way, a request ended, or the
   * reader asked for reduced motion. Text that is not an extension of what was
   * received (a new request, a retry) starts over. Text from `headEnd` on is
   * not on the screen while the text before it is (the plan turn writes part 1
   * behind the introduction): only the text before it takes time to reveal, so
   * a reader sees the introduction written at a readable speed and nothing is
   * later than LAG_MS.
   */
  receive(length: number, now: number, instant: boolean, headEnd = Number.POSITIVE_INFINITY): void {
    this.advance(now);
    if (length < this.received) {
      this.shownLength = Math.min(this.shownLength, length);
      this.pending = [];
      this.received = length;
    }
    const step = length - this.received;
    if (instant) {
      this.shownLength = length;
      this.pending = [];
    } else if (step > 0) {
      const behind = this.pending.at(-1)?.due;
      const visibleEnd = Math.min(length, Math.max(headEnd, this.received));
      const visible = visibleEnd - this.received;
      if (visible >= LUMP_MIN) this.pending.push({ start: this.received, end: visibleEnd, due: Math.max(now + LAG_MS, behind ?? 0), free: false });
      else if (visible > 0 && behind !== undefined) this.pending.push({ start: this.received, end: visibleEnd, due: behind, free: false });
      else if (visible > 0 && visibleEnd === length) this.shownLength = length;
      else if (visible > 0) this.shownLength = Math.max(this.shownLength, visibleEnd);
      if (visibleEnd < length) {
        const hiddenStart = Math.max(visibleEnd, this.received);
        if (behind === undefined && this.pending.length === 0) this.shownLength = length;
        else this.pending.push({ start: hiddenStart, end: length, due: this.pending.at(-1)?.due ?? now, free: true });
      }
    }
    this.received = length;
    this.lastAt = now;
    if (this.shownLength >= this.received) this.pending = [];
  }

  /** Moves the reveal to `now` and returns how many characters to show. */
  advance(now: number): number {
    const from = this.lastAt;
    this.lastAt = Math.max(from, now);
    if (this.pending.length === 0) return this.shownLength;
    // The speed that meets the tightest deadline: constant while one lump is being revealed.
    let speed = 0;
    for (const step of this.pending) if (!step.free) speed = Math.max(speed, (step.end - this.shownLength) / Math.max(step.due - from, 1));
    let next = Math.min(this.received, this.shownLength + Math.ceil(speed * Math.max(0, now - from)));
    for (const step of this.pending) {
      if (step.due <= now || (step.free && next >= step.start)) next = Math.max(next, step.end);
    }
    this.shownLength = next;
    this.pending = this.pending.filter((step) => step.end > this.shownLength);
    return this.shownLength;
  }
}

/** Payloads the pane read from a snapshot, not from the live channel: text that already existed, which is shown at once. */
const EXISTING = new WeakSet<StreamPayload>();
export function markExisting(payload: StreamPayload): StreamPayload {
  EXISTING.add(payload);
  return payload;
}
export const isExisting = (payload: StreamPayload): boolean => EXISTING.has(payload);

/** Cuts text at `length` without splitting a surrogate pair. */
export function prefixOf(text: string, length: number): string {
  if (length >= text.length) return text;
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}
