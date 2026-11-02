/**
 * The one call the export panel makes: rendered transcript in, one
 * self-contained HTML document out.
 */

import { buildExportDocument } from "./export-document.js";
import {
  AssetBudget,
  collectStyleSheetTexts,
  defaultFetcher,
  inlineImages,
  inlineStyleSheetUrls,
  replaceCanvases,
  resolvePageColors,
  sanitizeTree,
  waitForImages,
  type Fetcher,
} from "./snapshot.js";

export interface CaptureThreadOptions {
  /** The rendered transcript root, typically bb's `[data-thread-window]` element. */
  root: HTMLElement;
  title: string;
  /** Muted line under the title: where the thread ran, and when it was captured. */
  subtitle: string;
  document?: Document;
  fetcher?: Fetcher;
  /** How long to wait for images before capturing them as they are. */
  imageTimeoutMs?: number;
}

export interface CaptureThreadResult {
  html: string;
  /** Bytes of fonts, images, and stylesheet assets inlined into `html`. */
  assetBytes: number;
}

export async function captureThread(options: CaptureThreadOptions): Promise<CaptureThreadResult> {
  const doc = options.document ?? options.root.ownerDocument;
  const context = {
    fetcher: options.fetcher ?? defaultFetcher,
    origin: new URL(doc.baseURI).origin,
    baseUrl: doc.baseURI,
    budget: new AssetBudget(),
  };

  // Read the colors before cloning: the clone has no ancestors to inherit from.
  const colors = resolvePageColors(options.root);
  const clone = options.root.cloneNode(true) as HTMLElement;
  replaceCanvases(clone, options.root);
  sanitizeTree(clone);
  await inlineImages(clone, context);
  await waitForImages(clone, options.imageTimeoutMs);

  const sheets = await collectStyleSheetTexts(doc, context);
  const css = await inlineStyleSheetUrls(sheets, context);

  const htmlClassName = doc.documentElement.className;
  return {
    html: buildExportDocument({
      title: options.title,
      subtitle: options.subtitle,
      htmlClassName,
      htmlStyle: doc.documentElement.getAttribute("style") ?? "",
      lang: doc.documentElement.lang,
      theme: htmlClassName.split(/\s+/).includes("dark") ? "dark" : "light",
      pageBackground: colors.background,
      pageColor: colors.color,
      css,
      transcriptHtml: clone.outerHTML,
    }),
    assetBytes: context.budget.bytes,
  };
}

/** Where the thread ran and when it was captured, as the reader needs it. */
export function exportSubtitle(parts: { projectName?: string | null; capturedAt: Date }): string {
  const where = parts.projectName?.trim() ?? "";
  const when = parts.capturedAt.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return [where, `Exported from bb on ${when}`].filter((part) => part !== "").join(" · ");
}
