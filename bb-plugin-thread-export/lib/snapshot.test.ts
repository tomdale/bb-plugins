import { describe, expect, it } from "vitest";
import {
  AssetBudget,
  collectStyleSheetTexts,
  inlineImages,
  inlineStyleSheetUrls,
  replaceCanvases,
  sanitizeTree,
  type Fetcher,
  type InlineContext,
} from "./snapshot.js";

const ORIGIN = "http://localhost:3000";

function serve(
  files: Record<string, { body: string; contentType: string }>,
): { fetcher: Fetcher; seen: string[] } {
  const seen: string[] = [];
  const fetcher: Fetcher = async (url) => {
    seen.push(url);
    const file = files[url];
    if (file === undefined) return new Response("not found", { status: 404 });
    return new Response(file.body, { headers: { "content-type": file.contentType } });
  };
  return { fetcher, seen };
}

function context(fetcher: Fetcher, budget = new AssetBudget()): InlineContext {
  return { fetcher, origin: ORIGIN, baseUrl: `${ORIGIN}/`, budget };
}

const base64 = (text: string): string => Buffer.from(text).toString("base64");

describe("inlineStyleSheetUrls", () => {
  it("inlines a same-origin asset relative to the stylesheet that references it", async () => {
    const { fetcher, seen } = serve({
      [`${ORIGIN}/assets/inter.woff2`]: { body: "FONT", contentType: "font/woff2" },
    });
    const css = await inlineStyleSheetUrls(
      [{ text: "@font-face{src:url(/assets/inter.woff2)}", baseUrl: `${ORIGIN}/assets/app.css` }],
      context(fetcher),
    );
    expect(seen).toEqual([`${ORIGIN}/assets/inter.woff2`]);
    expect(css).toBe(`@font-face{src:url("data:font/woff2;base64,${base64("FONT")}")}`);
  });

  it("resolves relative asset paths against the stylesheet's own URL", async () => {
    const { fetcher, seen } = serve({
      [`${ORIGIN}/assets/img/bg.png`]: { body: "PNG", contentType: "image/png" },
    });
    await inlineStyleSheetUrls(
      [{ text: ".a{background:url(img/bg.png)}", baseUrl: `${ORIGIN}/assets/app.css` }],
      context(fetcher),
    );
    expect(seen).toEqual([`${ORIGIN}/assets/img/bg.png`]);
  });

  it("leaves cross-origin, data, and fragment references alone", async () => {
    const { fetcher, seen } = serve({});
    const input = [
      ".a{background:url(https://cdn.example/x.png)}",
      ".b{background:url(data:image/png;base64,AAA)}",
      ".c{fill:url(#gradient)}",
    ].join("\n");
    const css = await inlineStyleSheetUrls([{ text: input, baseUrl: `${ORIGIN}/assets/app.css` }], context(fetcher));
    expect(css).toBe(input);
    expect(seen).toEqual([]);
  });

  it("keeps the original URL when an asset cannot be fetched", async () => {
    const { fetcher } = serve({});
    const css = await inlineStyleSheetUrls(
      [{ text: ".a{background:url(/missing.png)}", baseUrl: `${ORIGIN}/assets/app.css` }],
      context(fetcher),
    );
    expect(css).toBe(".a{background:url(/missing.png)}");
  });

  it("stops inlining once the export budget is spent", async () => {
    const { fetcher } = serve({
      [`${ORIGIN}/big.woff2`]: { body: "0123456789", contentType: "font/woff2" },
    });
    const css = await inlineStyleSheetUrls(
      [{ text: ".a{src:url(/big.woff2)}", baseUrl: `${ORIGIN}/app.css` }],
      context(fetcher, new AssetBudget(4)),
    );
    expect(css).toBe(".a{src:url(/big.woff2)}");
  });

  it("keeps every loaded stylesheet, which is how plugin CSS reaches the export", async () => {
    const { fetcher } = serve({});
    const css = await inlineStyleSheetUrls(
      [
        { text: ".app{color:red}", baseUrl: `${ORIGIN}/assets/index.css` },
        { text: ".ui-block{display:flex}", baseUrl: `${ORIGIN}/assets/plugin.css` },
      ],
      context(fetcher),
    );
    expect(css).toContain(".app{color:red}");
    expect(css).toContain(".ui-block{display:flex}");
  });
});

describe("collectStyleSheetTexts", () => {
  it("reads the rules of stylesheets the app injected", async () => {
    document.head.innerHTML = "<style>.from-style-tag{color:red}</style>";
    const { fetcher } = serve({});
    const sheets = await collectStyleSheetTexts(document, context(fetcher));
    expect(sheets.map((sheet) => sheet.text).join("\n")).toContain(".from-style-tag");
  });
});

describe("sanitizeTree", () => {
  it("drops scripts, UI-only nodes, and event handlers", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <script>alert(1)</script>
      <button data-thread-export-omit="">Copy</button>
      <div contenteditable="true" onclick="steal()" tabindex="0" aria-label="kept">Message</div>`;
    sanitizeTree(root);
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("[data-thread-export-omit]")).toBeNull();
    const kept = root.querySelector("div");
    expect(kept?.hasAttribute("contenteditable")).toBe(false);
    expect(kept?.hasAttribute("onclick")).toBe(false);
    expect(kept?.hasAttribute("tabindex")).toBe(false);
    expect(kept?.getAttribute("aria-label")).toBe("kept");
  });
});

describe("replaceCanvases", () => {
  it("swaps a canvas for an image of its pixels", () => {
    const live = document.createElement("div");
    live.innerHTML = "<canvas aria-label='chart'></canvas>";
    const canvas = live.querySelector("canvas");
    if (canvas === null) throw new Error("canvas missing");
    canvas.toDataURL = () => "data:image/png;base64,AAAA";
    const clone = live.cloneNode(true) as HTMLElement;
    expect(replaceCanvases(clone, live)).toBe(1);
    const image = clone.querySelector("img");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(image?.getAttribute("alt")).toBe("chart");
  });
});

describe("inlineImages", () => {
  it("inlines a server-hosted image and leaves other origins as links", async () => {
    const { fetcher, seen } = serve({
      [`${ORIGIN}/api/attachment.png`]: { body: "PNG", contentType: "image/png" },
    });
    const root = document.createElement("div");
    root.innerHTML = `
      <img src="/api/attachment.png" srcset="/api/attachment.png 2x" loading="lazy">
      <img src="https://cdn.example/remote.png">`;
    await inlineImages(root, context(fetcher));
    const [local, remote] = Array.from(root.querySelectorAll("img"));
    expect(local?.getAttribute("src")).toBe(`data:image/png;base64,${base64("PNG")}`);
    expect(local?.hasAttribute("srcset")).toBe(false);
    expect(local?.getAttribute("loading")).toBe("eager");
    expect(remote?.getAttribute("src")).toBe("https://cdn.example/remote.png");
    expect(seen).toEqual([`${ORIGIN}/api/attachment.png`]);
  });
});
