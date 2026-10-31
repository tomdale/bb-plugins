// The tokenizer and the figure's use of it, without a page: what the grammars
// make of tricky text, how a diff's rows are split into the texts to read, and
// that nothing here can fail a figure.
import { describe, expect, it } from "vitest";
import { highlightForFigure, highlightTexts } from "../src/syntax/tokenizer.ts";
import { languageFor } from "../src/syntax/languages.ts";
import { ROLES, type LineTokens } from "../src/syntax/roles.ts";
import { parsePatchRows } from "../src/ui/patch-lines.ts";
import { chunksFor, forgetTokens, loadTokens, tokenKey } from "../src/ui/syntax.ts";
import type { WalkthroughRpc } from "../src/ui/hooks.ts";

/** The `[text, role]` pairs of one line: what the line reads as, independent of offsets. */
function painted(text: string, tokens: LineTokens): Array<[string, string]> {
  return tokens.map(([start, end, role]) => [text.slice(start, end), role]);
}
const roleAt = (text: string, tokens: LineTokens, needle: string) => {
  const at = text.indexOf(needle);
  return tokens.find(([start, end]) => start <= at && at + needle.length <= end)?.[2] ?? null;
};
async function lines(path: string, text: string): Promise<LineTokens[]> {
  const result = await highlightTexts(path, [text]);
  return result.texts[0]!;
}

describe("languages", () => {
  it("finds a grammar by extension and by file name, ignoring case", () => {
    expect(languageFor("src/a.ts")).toBe("typescript");
    expect(languageFor("src/App.TSX")).toBe("tsx");
    expect(languageFor("a/b/queue.rs")).toBe("rust");
    expect(languageFor("README.md")).toBe("markdown");
    expect(languageFor("deploy/run.sh")).toBe("shellscript");
    expect(languageFor("Cargo.lock")).toBe("toml");
    expect(languageFor("tsconfig.json")).toBe("jsonc");
    expect(languageFor("package.json")).toBe("json");
    expect(languageFor("x/Gemfile")).toBe("ruby");
    expect(languageFor("fix.patch")).toBe("diff");
  });

  it("has none for an unknown extension, no extension, or a dotfile with no grammar", () => {
    expect(languageFor("data.bin")).toBeNull();
    expect(languageFor("LICENSE")).toBeNull();
    expect(languageFor("src/.gitignore")).toBeNull();
    expect(languageFor("noext.")).toBeNull();
  });
});

describe("tokenizing", () => {
  it("carries a block comment across lines", async () => {
    const text = "/* first\n   second */ const a = 1;";
    const [one, two] = await lines("a.ts", text);
    expect(painted("/* first", one!)).toEqual([["/* first", "comment"]]);
    const second = "   second */ const a = 1;";
    expect(roleAt(second, two!, "second")).toBe("comment");
    expect(roleAt(second, two!, "const")).toBe("keyword");
    expect(roleAt(second, two!, "1")).toBe("number");
  });

  it("carries a template string across lines but reads code inside its holes", async () => {
    const text = "const s = `one\ntwo ${value}\nthree`;";
    const [, middle, last] = await lines("a.ts", text);
    expect(roleAt("two ${value}", middle!, "two")).toBe("string");
    expect(roleAt("two ${value}", middle!, "value")).toBeNull();
    expect(roleAt("three`;", last!, "three")).toBe("string");
  });

  it("gives the roles a reader expects in TypeScript, Rust, JSON and Markdown", async () => {
    const ts = "export function load(id: string): User { return db.users[id]; }";
    const [tsLine] = await lines("a.ts", ts);
    expect(roleAt(ts, tsLine!, "export")).toBe("keyword");
    expect(roleAt(ts, tsLine!, "load")).toBe("function");
    expect(roleAt(ts, tsLine!, "string")).toBe("type");
    expect(roleAt(ts, tsLine!, "User")).toBe("type");

    const rust = 'let n = 42u32; // count';
    const [rsLine] = await lines("a.rs", rust);
    expect(roleAt(rust, rsLine!, "let")).toBe("keyword");
    expect(roleAt(rust, rsLine!, "42")).toBe("number");
    expect(roleAt(rust, rsLine!, "// count")).toBe("comment");

    const json = '{ "name": "x", "n": 3, "ok": true }';
    const [jsonLine] = await lines("a.json", json);
    expect(roleAt(json, jsonLine!, "name")).toBe("property");
    expect(roleAt(json, jsonLine!, '"x"')).toBe("string");
    expect(roleAt(json, jsonLine!, "true")).toBe("number");

    const md = "# Title\n\nSome `code` here.\n\n```rust\nlet x = 1;\n```";
    const mdLines = await lines("a.md", md);
    expect(roleAt("# Title", mdLines[0]!, "Title")).toBe("heading");
    expect(roleAt("Some `code` here.", mdLines[2]!, "code")).toBe("string");
    // A fence is read in its own language, whether or not that grammar was asked for before.
    expect(roleAt("let x = 1;", mdLines[5]!, "let")).toBe("keyword");
    expect(roleAt("let x = 1;", mdLines[5]!, "x")).toBeNull();
  });

  it("returns only ordered, in-bounds stretches of known roles", async () => {
    const text = ["import { a } from './a';", "const b = `x${a}y` + /re+/g.source; // done", "class C<T> extends D { @dec() m(): void {} }"].join("\n");
    const result = await lines("a.ts", text);
    result.forEach((tokens, index) => {
      const line = text.split("\n")[index]!;
      let at = 0;
      for (const [start, end, role] of tokens) {
        expect(start).toBeGreaterThanOrEqual(at);
        expect(end).toBeGreaterThan(start);
        expect(end).toBeLessThanOrEqual(line.length);
        expect(ROLES).toContain(role);
        at = end;
      }
    });
  });

  it("keeps offsets when a line holds a lone carriage return", async () => {
    const text = "const a = 1;\r\nconst b = 2;\rconst c = 3;";
    const result = await lines("a.ts", text);
    expect(result).toHaveLength(2);
    const second = "const b = 2;\rconst c = 3;";
    const at = second.lastIndexOf("const");
    expect(result[1]).toContainEqual([at, at + 5, "keyword"]);
  });

  it("leaves a very long line plain and still reads the lines around it", async () => {
    const long = `const s = "${"x".repeat(6000)}";`;
    const started = performance.now();
    const result = await lines("a.ts", `const a = 1;\n${long}\nconst b = 2;`);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(result[1]).toEqual([]);
    expect(roleAt("const a = 1;", result[0]!, "const")).toBe("keyword");
    expect(roleAt("const b = 2;", result[2]!, "const")).toBe("keyword");
  });

  it("answers empty text with one plain line and binary text with nothing", async () => {
    expect(await lines("a.ts", "")).toEqual([[]]);
    const result = await highlightTexts("a.ts", ["a\u0000b", "const x = 1;"]);
    expect(result.texts[0]).toBeNull();
    expect(result.texts[1]).not.toBeNull();
  });

  it("answers an unknown extension with no language and no tokens", async () => {
    expect(await highlightTexts("data.xyz", ["const a = 1;"])).toEqual({ language: null, texts: [null] });
  });

  it("never throws for a figure: a failure leaves every text plain", async () => {
    const result = await highlightForFigure("a.ts", ["const a = 1;"]);
    expect(result.language).toBe("typescript");
    expect(result.texts[0]).not.toBeNull();
  });
});

const patch = (lines: string[], start = 1) => ["diff --git a/f.ts b/f.ts", "--- a/f.ts", "+++ b/f.ts", `@@ -${start},${lines.length} +${start},${lines.length} @@`, ...lines, ""].join("\n");

describe("a diff's texts", () => {
  it("reads added and context lines as the new text and removed lines as the old", () => {
    const rows = parsePatchRows(patch([" a", "-old1", "-old2", "+new", " b"]));
    const chunks = chunksFor(rows);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["a\nnew\nb", "a\nold1\nold2\nb"]);
    // Context rows take their tokens from the new text; the old text supplies only the removed rows.
    expect(chunks[0]!.rows).toEqual([0, 3, 4]);
    expect(chunks[1]!.rows).toEqual([null, 1, 2, null]);
  });

  it("reads only the new side when nothing was removed, and breaks the text at a gap between hunks", () => {
    const text = [...patch([" a", "+b"], 1).split("\n").slice(0, -1), "@@ -20,2 +21,2 @@", " c", " d", ""].join("\n");
    const chunks = chunksFor(parsePatchRows(text));
    expect(chunks.map((chunk) => chunk.text)).toEqual(["a\nb", "c\nd"]);
  });

  it("colours a line by the state its own side is in, not the other side's", async () => {
    forgetTokens();
    // Removed lines sit inside a block comment in the old text; the added line replacing them is code in the new text.
    const rows = parsePatchRows(patch(["-/* old", "-   still old", "-*/ call();", "+call();"]));
    const rpc = { call: (_name: string, input: { path: string; texts: string[] }) => highlightForFigure(input.path, input.texts) } as unknown as WalkthroughRpc;
    const chunks = chunksFor(rows);
    const tokens = (await loadTokens(rpc, tokenKey("f.ts", null, "1-4", "change", chunks), "f.ts", chunks))!;
    expect(roleAt("   still old", tokens.get(1)!, "still")).toBe("comment");
    expect(roleAt("call();", tokens.get(3)!, "call")).toBe("function");
  });

  it("remembers a figure's tokens by file, revision, range, view and code", async () => {
    forgetTokens();
    let calls = 0;
    const rpc = { call: (_name: string, input: { path: string; texts: string[] }) => (calls++, highlightForFigure(input.path, input.texts)) } as unknown as WalkthroughRpc;
    const rows = parsePatchRows(patch([" const a = 1;"]));
    const chunks = chunksFor(rows);
    const key = tokenKey("f.ts", "abc1234", "1-1", "after", chunks);
    await loadTokens(rpc, key, "f.ts", chunks);
    await loadTokens(rpc, key, "f.ts", chunks);
    expect(calls).toBe(1);
    expect(tokenKey("f.ts", "abc1234", "1-1", "after", chunksFor(parsePatchRows(patch([" const a = 2;"]))))).not.toBe(key);
    expect(tokenKey("f.ts", "def5678", "1-1", "after", chunks)).not.toBe(key);
  });

  it("settles to null, never rejects, when the server fails", async () => {
    forgetTokens();
    const rpc = { call: () => Promise.reject(new Error("down")) } as unknown as WalkthroughRpc;
    const chunks = chunksFor(parsePatchRows(patch([" x"])));
    await expect(loadTokens(rpc, "k", "f.ts", chunks)).resolves.toBeNull();
  });
});
