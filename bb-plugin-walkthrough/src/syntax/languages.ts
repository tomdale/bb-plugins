// Which grammar a path is read with. Pure and shared: the page uses it to skip
// the round trip for files with no grammar, the server to pick the grammar.

export type LanguageId =
  | "typescript" | "tsx" | "javascript" | "jsx" | "json" | "jsonc" | "css" | "scss" | "html" | "markdown" | "shellscript"
  | "python" | "rust" | "go" | "ruby" | "java" | "c" | "cpp" | "yaml" | "toml" | "sql" | "swift" | "diff";

const BY_EXTENSION: Record<string, LanguageId> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  json: "json", jsonc: "jsonc", json5: "jsonc",
  css: "css", scss: "scss",
  html: "html", htm: "html",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  py: "python", pyi: "python",
  rs: "rust",
  go: "go",
  rb: "ruby", rake: "ruby", gemspec: "ruby",
  java: "java",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp",
  yml: "yaml", yaml: "yaml",
  toml: "toml",
  sql: "sql",
  swift: "swift",
  diff: "diff", patch: "diff",
};

/** Files known by their whole name, lowercased. */
const BY_NAME: Record<string, LanguageId> = {
  gemfile: "ruby", rakefile: "ruby", podfile: "ruby",
  ".bashrc": "shellscript", ".zshrc": "shellscript", ".profile": "shellscript", ".zprofile": "shellscript",
  "cargo.lock": "toml",
  "tsconfig.json": "jsonc", "jsconfig.json": "jsonc",
};

/** The grammar for `path`, or null for an unknown extension (the figure then stays plain monospace). */
export function languageFor(path: string): LanguageId | null {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  const named = BY_NAME[name];
  if (named) return named;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}
