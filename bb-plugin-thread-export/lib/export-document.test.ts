import { describe, expect, it } from "vitest";
import { buildExportDocument, escapeHtml } from "./export-document.js";

const BASE = {
  title: "Fix the flaky test",
  subtitle: "tomdaleOS · Exported from bb on Nov 2, 2026",
  htmlClassName: "bb-app-shell-root dark",
  htmlStyle: "",
  lang: "en",
  theme: "dark" as const,
  pageBackground: "rgb(21, 21, 21)",
  pageColor: "rgb(237, 237, 237)",
  css: ".row { color: red }",
  transcriptHtml: '<div data-thread-window=""><p>Hello</p></div>',
};

describe("buildExportDocument", () => {
  it("wraps the transcript in a standalone page", () => {
    const html = buildExportDocument(BASE);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en" class="bb-app-shell-root dark">');
    expect(html).toContain("<title>Fix the flaky test · bb</title>");
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    expect(html).toContain(".row { color: red }");
    expect(html).toContain('<div data-thread-window=""><p>Hello</p></div>');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("carries the theme class that selects bb's dark palette", () => {
    expect(buildExportDocument(BASE)).toContain('class="bb-app-shell-root dark"');
    expect(
      buildExportDocument({ ...BASE, htmlClassName: "", theme: "light" }),
    ).toContain('<html lang="en">');
  });

  it("escapes the title and subtitle instead of letting markup through", () => {
    const html = buildExportDocument({
      ...BASE,
      title: '<img src=x onerror="alert(1)">',
      subtitle: "a & b < c",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("a &amp; b &lt; c");
    expect(html).not.toContain("<script");
  });

  it("keeps the export frame out of the transcript's way", () => {
    const html = buildExportDocument(BASE);
    expect(html).toContain(".te-transcript");
    expect(html).toContain("@media print");
  });

  it("lets the exported document scroll, which the app shell prevents", () => {
    const html = buildExportDocument(BASE);
    expect(html).toContain("html,\nbody {\n  height: auto !important;");
    expect(html).toContain("overflow: visible !important;");
  });

  it("paints the page in the colors bb was showing", () => {
    const html = buildExportDocument(BASE);
    expect(html).toContain("background: rgb(21, 21, 21);");
    expect(html).toContain("color: rgb(237, 237, 237);");
    const withoutColors = buildExportDocument({ ...BASE, pageBackground: null, pageColor: null });
    expect(withoutColors).not.toContain("background: rgb(21, 21, 21);");
  });
});

describe("escapeHtml", () => {
  it("escapes every character that could break out of markup", () => {
    expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });
});
