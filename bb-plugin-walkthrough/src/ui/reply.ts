// The helper agent inherits its thread's reply format, so an answer can arrive
// wrapped in a `:::reply{state="…" kind="…"}` … `:::` block. The wrapper is
// protocol, not prose: it is removed before an answer is shown, including while
// the answer is still streaming and the wrapper is only partly written.

const WORD = "reply";

/** The text of an answer without its reply wrapper; text with no wrapper is returned unchanged. */
export function stripReplyWrapper(text: string): string {
  let rest = text;
  // A wrapper may itself arrive wrapped (an agent quoting its own format); peel at most a few layers.
  for (let layer = 0; layer < 3; layer += 1) {
    const peeled = peel(rest);
    if (peeled === rest) break;
    rest = peeled;
  }
  return rest;
}

function peel(text: string): string {
  const lead = text.match(/^\s*/u)![0].length;
  const body = text.slice(lead);
  if (!body.startsWith(":")) return text;
  const newline = body.indexOf("\n");
  const first = newline < 0 ? body : body.slice(0, newline);
  const opener = /^(:{3,})reply(\{[^\n]*\})?[ \t]*$/u.exec(first);
  if (opener === null) {
    // Still writing the opener: nothing to show until the line is complete.
    return newline < 0 && isPartialOpener(first) ? "" : text;
  }
  if (newline < 0) return "";
  const colons = opener[1]!.length;
  let content = body.slice(newline + 1);
  // The closing fence has the opening one's colon count; a shorter run is a closer being typed.
  const closer = new RegExp(`(?:^|\\n)[ \\t]*:{1,${colons}}[ \\t]*$`, "u").exec(content);
  if (closer !== null) content = content.slice(0, closer.index);
  return content.replace(/^\n+/u, "").replace(/\s+$/u, "");
}

/** Whether `line` could still become `:::reply{…}` (a prefix of the opener, with no newline yet). */
function isPartialOpener(line: string): boolean {
  const match = /^(:+)([a-z]*)(\{[^\n]*)?$/u.exec(line);
  if (match === null) return false;
  const [, colons, word, attributes] = match;
  if (attributes !== undefined) return colons!.length >= 3 && word === WORD;
  return WORD.startsWith(word!) && (colons!.length >= 3 || word === "");
}
