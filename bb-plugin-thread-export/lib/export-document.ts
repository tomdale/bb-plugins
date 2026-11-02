/**
 * Assembles the standalone page around a captured transcript.
 *
 * The transcript keeps bb's own class names, so the app's CSS (inlined
 * alongside) styles it exactly as the app does. This module only adds the
 * page frame: a heading, one reading column, and print rules.
 */

export interface ExportDocumentInput {
  title: string;
  subtitle: string;
  /** Class names from the app's `<html>`; `dark` carries bb's dark palette. */
  htmlClassName: string;
  /** Inline custom properties the theme set on `<html>`, if any. */
  htmlStyle: string;
  lang: string;
  theme: "light" | "dark";
  /** Every stylesheet the app had loaded at capture time. */
  css: string;
  transcriptHtml: string;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * The export's own frame. Deliberately small: bb's tokens come from the app
 * CSS, and every value here has a fallback so a partial capture still reads.
 */
export const EXPORT_CHROME_CSS = `
.te-page {
  min-height: 100vh;
  background: var(--canvas, var(--background, #fff));
  color: var(--foreground, #1a1a1a);
}
.te-header {
  max-width: 820px;
  margin: 0 auto;
  padding: 40px 24px 4px;
}
.te-title {
  margin: 0;
  font-size: 1.375rem;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.te-subtitle {
  margin: 6px 0 0;
  font-size: 0.8125rem;
  line-height: 1.4;
  color: var(--muted-foreground, #6b7280);
}
.te-transcript {
  max-width: 820px;
  margin: 0 auto 0;
}
@media print {
  .te-page {
    background: #fff;
    color: #000;
  }
  .te-header {
    padding-top: 0;
  }
  .te-transcript {
    max-width: none;
  }
}
`.trim();

export function buildExportDocument(input: ExportDocumentInput): string {
  const htmlClass = input.htmlClassName.trim();
  const htmlStyle = input.htmlStyle.trim();
  const classAttribute = htmlClass === "" ? "" : ` class="${escapeHtml(htmlClass)}"`;
  const styleAttribute = htmlStyle === "" ? "" : ` style="${escapeHtml(htmlStyle)}"`;
  return `<!doctype html>
<html lang="${escapeHtml(input.lang || "en")}"${classAttribute}${styleAttribute}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${input.theme}">
<meta name="generator" content="bb thread export">
<title>${escapeHtml(input.title)} · bb</title>
<style>
${input.css}
</style>
<style>
${EXPORT_CHROME_CSS}
</style>
</head>
<body class="bb-app-shell">
<main class="te-page">
<header class="te-header">
<h1 class="te-title">${escapeHtml(input.title)}</h1>
<p class="te-subtitle">${escapeHtml(input.subtitle)}</p>
</header>
<div class="te-transcript">
${input.transcriptHtml}
</div>
</main>
</body>
</html>
`;
}
