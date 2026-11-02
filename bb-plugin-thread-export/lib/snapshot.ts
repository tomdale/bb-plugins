/**
 * Turns a rendered bb transcript into markup and CSS that stand on their own.
 *
 * Everything here works on a *clone* of the live DOM: the app's timeline is
 * live React state, and a snapshot must never touch it. Assets that the page
 * server can serve (the bundled fonts, timeline images, attachments) are
 * fetched and inlined as data URLs, because the reader opens the file without
 * access to the bb server it came from.
 */

/** Fetches bytes by absolute URL; injected so the pipeline is testable. */
export type Fetcher = (url: string) => Promise<Response>;

const MAX_ASSET_BYTES = 4_000_000;
const ASSET_BUDGET_BYTES = 16_000_000;

export const defaultFetcher: Fetcher = (url) =>
  fetch(url, { credentials: "include" });

/** Total bytes inlined into one export, across CSS and images. */
export class AssetBudget {
  private used = 0;

  constructor(private readonly limit = ASSET_BUDGET_BYTES) {}

  take(bytes: number): boolean {
    if (this.used + bytes > this.limit) return false;
    this.used += bytes;
    return true;
  }

  get bytes(): number {
    return this.used;
  }
}

export interface InlineContext {
  fetcher: Fetcher;
  /** Origin of the bb app the snapshot came from; assets elsewhere stay links. */
  origin: string;
  /** Base for relative URLs in the snapshot markup. */
  baseUrl: string;
  budget: AssetBudget;
}

export interface StyleSheetText {
  text: string;
  /** Base for `url()` inside this sheet's rules. */
  baseUrl: string;
}

/** A same-origin asset worth inlining, or `null` when it already stands alone. */
function inlineableUrl(reference: string, baseUrl: string, origin: string): string | null {
  const trimmed = reference.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("data:")) {
    return null;
  }
  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return null;
  }
  // A cross-origin asset cannot be read back, so leaving its URL keeps the
  // export honest instead of silently dropping the image.
  return resolved.origin === origin ? resolved.href : null;
}

function toDataUrl(bytes: Uint8Array, contentType: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  const type = contentType.split(";")[0]?.trim() || "application/octet-stream";
  return `data:${type};base64,${btoa(binary)}`;
}

async function fetchAsset(url: string, context: InlineContext): Promise<string | null> {
  try {
    const response = await context.fetcher(url);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) return null;
    if (!context.budget.take(bytes.byteLength)) return null;
    return toDataUrl(bytes, response.headers.get("content-type") ?? "");
  } catch {
    return null;
  }
}

/**
 * Every stylesheet the app currently has loaded, as text. bb splits CSS per
 * route and per plugin, so this is the only way to include the classes a
 * transcript actually uses — plugin styles for inline UI blocks included.
 */
export async function collectStyleSheetTexts(
  doc: Document,
  context: InlineContext,
): Promise<StyleSheetText[]> {
  const sheets: StyleSheetText[] = [];
  const baseUrl = doc.baseURI;
  for (const sheet of Array.from(doc.styleSheets)) {
    const href = sheet.href;
    const ownBase = href ?? baseUrl;
    try {
      const rules = Array.from(sheet.cssRules ?? []);
      sheets.push({ text: rules.map((rule) => rule.cssText).join("\n"), baseUrl: ownBase });
      continue;
    } catch {
      // Cross-origin sheet: its rules are unreadable, so re-fetch the text.
    }
    if (href === null) continue;
    try {
      const response = await context.fetcher(href);
      if (!response.ok) continue;
      sheets.push({ text: await response.text(), baseUrl: href });
    } catch {
      // A stylesheet we cannot read leaves the export without its rules;
      // earning a hard failure here would cost the whole snapshot.
    }
  }
  return sheets;
}

const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** Replaces same-origin `url()` references so the file needs no server. */
export async function inlineStyleSheetUrls(
  sheets: readonly StyleSheetText[],
  context: InlineContext,
): Promise<string> {
  const parts: string[] = [];
  for (const sheet of sheets) {
    const replacements = new Map<string, string>();
    for (const match of sheet.text.matchAll(CSS_URL_PATTERN)) {
      const reference = match[2] ?? "";
      if (replacements.has(reference)) continue;
      const url = inlineableUrl(reference, sheet.baseUrl, context.origin);
      if (url === null) continue;
      const dataUrl = await fetchAsset(url, context);
      if (dataUrl !== null) replacements.set(reference, dataUrl);
    }
    const text =
      replacements.size === 0
        ? sheet.text
        : sheet.text.replace(CSS_URL_PATTERN, (whole, _quote: string, reference: string) => {
            const dataUrl = replacements.get(reference);
            return dataUrl === undefined ? whole : `url("${dataUrl}")`;
          });
    parts.push(text);
  }
  return parts.join("\n");
}

/** Swaps each clone canvas for an image of the live canvas beside it. */
export function replaceCanvases(clone: ParentNode, live: ParentNode): number {
  const cloned = Array.from(clone.querySelectorAll("canvas"));
  const liveCanvases = Array.from(live.querySelectorAll("canvas"));
  if (cloned.length !== liveCanvases.length) return 0;
  let replaced = 0;
  for (const [index, canvas] of cloned.entries()) {
    const source = liveCanvases[index];
    if (source === undefined) continue;
    let dataUrl: string;
    try {
      dataUrl = source.toDataURL("image/png");
    } catch {
      continue; // Tainted canvas: leave the (blank) element in place.
    }
    if (dataUrl === "data:,") continue;
    const image = source.ownerDocument.createElement("img");
    image.setAttribute("src", dataUrl);
    image.setAttribute("alt", source.getAttribute("aria-label") ?? "");
    image.className = canvas.className;
    const width = source.clientWidth;
    const height = source.clientHeight;
    if (width > 0) image.setAttribute("width", String(Math.round(width)));
    if (height > 0) image.setAttribute("height", String(Math.round(height)));
    canvas.replaceWith(image);
    replaced += 1;
  }
  return replaced;
}

/** Points every image at inlined bytes, or at the URL it was loaded from. */
export async function inlineImages(
  root: ParentNode,
  context: InlineContext,
): Promise<void> {
  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    images.map(async (image) => {
      image.removeAttribute("srcset");
      image.setAttribute("loading", "eager");
      image.removeAttribute("decoding");
      const source = image.getAttribute("src");
      if (source === null) return;
      const url = inlineableUrl(source, context.baseUrl, context.origin);
      const target = url ?? (source.startsWith("blob:") ? source : null);
      if (target === null) return;
      const dataUrl = await fetchAsset(target, context);
      if (dataUrl !== null) image.setAttribute("src", dataUrl);
    }),
  );
}

/**
 * Removes what only makes sense in a running app: scripts, event handlers,
 * live edit affordances, and anything the plugin marked as UI-only.
 */
export function sanitizeTree(root: ParentNode): void {
  root.querySelectorAll("script, link, noscript").forEach((node) => node.remove());
  root.querySelectorAll("[data-thread-export-omit]").forEach((node) => node.remove());
  const elements: Element[] = [];
  if (root instanceof Element) elements.push(root);
  elements.push(...Array.from(root.querySelectorAll("*")));
  for (const element of elements) {
    element.removeAttribute("contenteditable");
    element.removeAttribute("spellcheck");
    element.removeAttribute("autofocus");
    element.removeAttribute("tabindex");
    element.removeAttribute("inert");
    for (const name of Array.from(element.getAttributeNames())) {
      if (name.startsWith("on")) element.removeAttribute(name);
    }
  }
}

/**
 * The colors the app actually painted behind the transcript. bb layers these
 * through themed wrappers, not `--canvas` on the root, so the export reads the
 * resolved values from the tree instead of guessing at tokens.
 */
export function resolvePageColors(root: Element): {
  background: string | null;
  color: string | null;
} {
  const view = root.ownerDocument.defaultView;
  if (view === null) return { background: null, color: null };
  let background: string | null = null;
  let node: Element | null = root;
  while (node !== null) {
    const value = view.getComputedStyle(node).backgroundColor;
    if (isVisibleColor(value)) {
      background = value;
      break;
    }
    node = node.parentElement;
  }
  const color = view.getComputedStyle(root).color;
  return { background, color: isVisibleColor(color) ? color : null };
}

function isVisibleColor(value: string): boolean {
  if (value === "" || value === "transparent") return false;
  const alpha = /rgba\([^)]*,\s*([0-9.]+)\s*\)/.exec(value);
  return alpha === null || Number(alpha[1]) > 0;
}

/** Resolves once every image in the tree has decoded, or the timeout passes. */
export async function waitForImages(root: ParentNode, timeoutMs = 3_000): Promise<void> {
  const images = Array.from(root.querySelectorAll("img"));
  if (images.length === 0) return;
  const decode = (image: HTMLImageElement) =>
    image.complete
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        });
  await Promise.race([
    Promise.all(images.map(decode)).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
