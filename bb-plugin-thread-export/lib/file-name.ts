/**
 * Builds the file name a colleague sees: the thread's title, readably, plus a
 * little of the thread id so two exports of similar titles stay distinct.
 */

const MAX_SLUG_LENGTH = 60;

export function exportFileName(title: string | null | undefined, threadId: string): string {
  const slug = (title ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  const id = threadId.replace(/^thr_/, "").replace(/[^a-z0-9]/gi, "").slice(0, 8);
  const stamp = new Date().toISOString().slice(0, 10);
  return `${slug || "bb-thread"}${id === "" ? "" : `-${id}`}-${stamp}.html`;
}
