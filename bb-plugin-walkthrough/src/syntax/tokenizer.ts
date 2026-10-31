// Tokenizes source text into role-tagged lines with Shiki's TextMate grammars.
// This runs in the plugin server, not the page: a plugin ships one app.js, so
// grammars loaded in the page would all sit in that file, while here each one
// is a lazily initialised module that costs nothing until a file of its
// language is read. The oniguruma engine (inlined wasm) keeps grammar
// semantics exact.
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { languageFor, type LanguageId } from "./languages.ts";
import { NOTEBOOK_THEME, roleOfColor } from "./notebook-theme.ts";
import { MAX_TEXT } from "./limits.ts";
import type { Highlighted, LineToken, LineTokens } from "./roles.ts";

/** A line longer than this stays plain: a minified bundle would cost seconds and read as noise anyway. */
const MAX_LINE = 3000;

type Grammar = () => Promise<{ default: unknown }>;
const GRAMMARS: Record<LanguageId, Grammar> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  html: () => import("@shikijs/langs/html"),
  markdown: () => import("@shikijs/langs/markdown"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  go: () => import("@shikijs/langs/go"),
  ruby: () => import("@shikijs/langs/ruby"),
  java: () => import("@shikijs/langs/java"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  diff: () => import("@shikijs/langs/diff"),
};

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<LanguageId, Promise<void>>();

function engine(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({ themes: [NOTEBOOK_THEME], langs: [], engine: createOnigurumaEngine(import("shiki/wasm")) });
  return highlighter;
}

function loadGrammar(core: HighlighterCore, language: LanguageId): Promise<void> {
  let ready = loaded.get(language);
  if (!ready) {
    ready = GRAMMARS[language]().then((module) => core.loadLanguage(module.default as never));
    loaded.set(language, ready);
    // A grammar that failed to load is retried by the next request instead of failing every later one.
    ready.catch(() => loaded.delete(language));
  }
  return ready;
}

/**
 * Languages a Markdown fence can name. They are always loaded with Markdown:
 * a fence is coloured by whichever grammars happen to be registered, so loading
 * them only when another figure had asked first would colour the same README
 * differently from one visit to the next.
 */
const FENCE_LANGUAGES: LanguageId[] = ["typescript", "tsx", "javascript", "jsx", "json", "jsonc", "shellscript", "python", "rust", "go", "ruby", "java", "yaml", "toml", "css", "html", "sql", "swift", "diff"];

async function withLanguage(language: LanguageId): Promise<HighlighterCore> {
  const core = await engine();
  await Promise.all([loadGrammar(core, language), ...(language === "markdown" ? FENCE_LANGUAGES.map((fence) => loadGrammar(core, fence)) : [])]);
  return core;
}

const hasBinary = (text: string) => text.includes("\u0000");

/** Lines of role tokens for one text; plain stretches carry no token. Null for text that should stay plain (binary, over the cap). */
function tokenizeText(core: HighlighterCore, language: LanguageId, text: string): LineTokens[] | null {
  if (text.length > MAX_TEXT || hasBinary(text)) return null;
  // A lone CR would split a line inside Shiki, shifting every later line; a space keeps every offset.
  const source = text.replace(/\r/gu, " ");
  const lines = core.codeToTokensBase(source, { lang: language, theme: NOTEBOOK_THEME.name, tokenizeMaxLineLength: MAX_LINE });
  return lines.map((tokens): LineTokens => {
    const found: LineToken[] = [];
    let at = 0;
    for (const token of tokens) {
      const end = at + token.content.length;
      const role = roleOfColor(token.color);
      if (role && end > at) {
        const last = found.at(-1);
        // Neighbouring tokens of one role are one stretch.
        if (last && last[1] === at && last[2] === role) found[found.length - 1] = [last[0], end, role];
        else found.push([at, end, role]);
      }
      at = end;
    }
    return found;
  });
}

/** Tokens for each of `texts` as lines of the file at `path`; each text is tokenized whole, so multi-line strings and comments carry across its lines. */
export async function highlightTexts(path: string, texts: string[]): Promise<Highlighted> {
  const language = languageFor(path);
  if (!language) return { language: null, texts: texts.map(() => null) };
  const core = await withLanguage(language);
  return { language, texts: texts.map((text) => tokenizeText(core, language, text)) };
}

/** `highlightTexts` for an RPC: a grammar or engine failure leaves every text plain instead of failing the figure. */
export async function highlightForFigure(path: string, texts: string[]): Promise<Highlighted> {
  try {
    return await highlightTexts(path, texts);
  } catch {
    return { language: languageFor(path), texts: texts.map(() => null) };
  }
}
