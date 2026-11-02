import { describe, expect, it } from "vitest";
import { captureThread, exportSubtitle } from "./capture-thread.js";
import type { Fetcher } from "./snapshot.js";

const ORIGIN = "http://localhost:3000";

function fetcherFor(files: Record<string, { body: string; contentType: string }>): Fetcher {
  return async (url) => {
    const file = files[url];
    if (file === undefined) return new Response("not found", { status: 404 });
    return new Response(file.body, { headers: { "content-type": file.contentType } });
  };
}

describe("captureThread", () => {
  it("produces a page that needs neither the server nor the app", async () => {
    document.documentElement.className = "bb-app-shell-root dark";
    document.head.innerHTML = "<style>.row{color:red}</style>";
    document.body.innerHTML = `
      <div data-thread-window=""><div class="row">Hello <img src="/api/x.png"></div></div>`;
    const root = document.querySelector<HTMLElement>("[data-thread-window]");
    if (root === null) throw new Error("transcript missing");

    const result = await captureThread({
      root,
      title: "Shared thread",
      subtitle: "tomdaleOS · Exported from bb",
      fetcher: fetcherFor({
        [`${ORIGIN}/api/x.png`]: { body: "PNG", contentType: "image/png" },
      }),
      imageTimeoutMs: 10,
    });

    expect(result.html).toContain("<!doctype html>");
    expect(result.html).toContain('class="bb-app-shell-root dark"');
    expect(result.html).toContain(".row");
    expect(result.html).toContain("color: red");
    expect(result.html).toContain("Hello");
    expect(result.html).toContain("data:image/png;base64,");
    expect(result.html).not.toContain(`src="/api/x.png"`);
    expect(result.assetBytes).toBeGreaterThan(0);
  });

  it("leaves the live transcript untouched", async () => {
    document.documentElement.className = "bb-app-shell-root";
    document.body.innerHTML = `<div data-thread-window=""><div class="row">Hello</div></div>`;
    const root = document.querySelector<HTMLElement>("[data-thread-window]");
    if (root === null) throw new Error("transcript missing");
    const before = document.body.innerHTML;
    await captureThread({
      root,
      title: "Shared thread",
      subtitle: "",
      fetcher: fetcherFor({}),
      imageTimeoutMs: 10,
    });
    expect(document.body.innerHTML).toBe(before);
  });
});

describe("exportSubtitle", () => {
  it("names where the thread ran and when it was captured", () => {
    const subtitle = exportSubtitle({
      projectName: "tomdaleOS",
      capturedAt: new Date("2026-11-02T09:45:00Z"),
    });
    expect(subtitle.startsWith("tomdaleOS · Exported from bb on ")).toBe(true);
  });

  it("falls back to just the date for a projectless thread", () => {
    expect(exportSubtitle({ capturedAt: new Date(0) }).startsWith("Exported from bb on ")).toBe(true);
    expect(exportSubtitle({ projectName: "  ", capturedAt: new Date(0) }).startsWith("Exported")).toBe(
      true,
    );
  });
});
