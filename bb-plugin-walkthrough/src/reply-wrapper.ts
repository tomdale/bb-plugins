// The helper is forked from the user's thread, so it can inherit that thread's
// reply format and wrap an answer in a `:::reply{state="…" kind="…"}` … `:::`
// block. The wrapper is protocol, not prose: stored answers and streamed text
// never carry it, including while it is only partly written.

const OPENER = /^(:{3,})reply(\{[^\n]*\})?[ \t]*$/u;

/** Whether `line` could still become a reply opener (a prefix of `:::reply{…}`, no newline yet). */
function isPartialOpener(line: string): boolean {
  const match = /^(:+)([a-z]*)(\{[^\n]*)?$/u.exec(line);
  if (match === null) return false;
  const [, colons = "", word = "", attributes] = match;
  if (attributes !== undefined) return colons.length >= 3 && word === "reply";
  return "reply".startsWith(word) && (colons.length >= 3 || word === "");
}

function peel(text: string): string {
  const lead = /^\s*/u.exec(text)![0].length;
  const body = text.slice(lead);
  if (!body.startsWith(":")) return text;
  const newline = body.indexOf("\n");
  const first = newline < 0 ? body : body.slice(0, newline);
  const opener = OPENER.exec(first);
  // A half-typed opener shows nothing yet, so a streaming answer never flashes colons.
  if (opener === null) return newline < 0 && isPartialOpener(first) ? "" : text;
  if (newline < 0) return "";
  const colons = opener[1]!.length;
  let content = body.slice(newline + 1);
  // The closer has the opener's colon count; a shorter run is a closer still being written.
  const closer = new RegExp(`(?:^|\\n)[ \\t]*:{1,${colons}}[ \\t]*$`, "u").exec(content);
  if (closer !== null) content = content.slice(0, closer.index);
  return content.replace(/^\n+/u, "").replace(/\s+$/u, "");
}

/** The text without its reply wrapper (up to three nested layers); text with no wrapper is unchanged. */
export function stripReplyWrapper(text: string): string {
  let rest = text;
  for (let layer = 0; layer < 3; layer += 1) {
    const peeled = peel(rest);
    if (peeled === rest) break;
    rest = peeled;
  }
  return rest;
}
