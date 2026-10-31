# Syntax highlighting in figures

Every figure (code, diff, after, before; saved snapshot or `excerpt` RPC) colours its code. The figure keeps its own gutter, markers, word-level diff overlay, tints and keyboard cursor; colour is a set of spans inside each row's text and nothing else.

## How it works

1. **Rows first.** A figure renders plain monospace rows as before. Nothing waits for colour.
2. **One RPC.** Once the figure is complete (not while it streams) and its path has a grammar, the page calls `highlight({ path, texts })`. `texts` are the code the figure shows, read as continuous text:
   - added and context lines are the file's new text, removed lines its old text, each tokenized whole, so a template string or block comment that spans lines is coloured on every line (`chunksFor` in `src/ui/syntax.ts`);
   - hunks are tokenized apart, because the lines skipped between them could change the state;
   - the old text is sent only when something was removed, and supplies only the removed rows.
3. **Role-tagged lines come back** (`src/syntax/tokenizer.ts`): per line, `[start, end, role]` over UTF-16 offsets of the line's text; plain stretches carry no token. The rows wrap those stretches in `<span class="wt-tk wt-tk-<role>">`.
4. **Tokens swap in without layout shift.** A span sets a colour and nothing else (the heading role also sets weight, and monospace bold has the same advance). In headless Chrome the row tops, row heights and figure sizes are identical before and after, row text widths differ by at most 0.36 px on a 5,400 px line, and the text content is identical.
5. **Memory.** Tokens are cached by path, revision, line range, view and a fingerprint of the code, so a figure that remounts (paging back to a part) paints coloured at once.

Exposed for other code: `data-language` on the `<figure>` (the grammar id, absent when the file has none), `data-highlighted` once tokens are in, and the nine role names in `src/syntax/roles.ts`.

## Why the server tokenizes

A plugin ships one `app.js` (BB serves only `app.js` and `app.css` from `dist/`), so grammars bundled for the page would all load with it: roughly 2 MB of grammar JSON for the languages below. In the server bundle each grammar is a module initialised on first use, so a TypeScript figure costs a TypeScript grammar and nothing else. The page's own bundle grew by 3 KB (JS) and 1 KB (CSS). The cost is a round trip, measured at about 55-65 ms after the rows are on screen for a warm grammar and 150-250 ms for the first figure of a language.

Engine: Shiki with the oniguruma engine (inlined wasm), not the JavaScript regex engine, which was 4-5 times slower on the same text and approximates some grammars.

Languages: TypeScript, TSX, JavaScript, JSX, JSON (JSONC for `tsconfig.json`), CSS, SCSS, HTML, Markdown, shell, Python, Rust, Go, Ruby, Java, C, C++, YAML, TOML, SQL, Swift, diff. `src/syntax/languages.ts` maps extensions and some file names; an unknown extension is plain and never reaches the server. A Markdown file also registers the other grammars, always, so a fenced block is coloured the same on every visit instead of depending on which figure came first.

Limits: a line over 3,000 characters stays plain, text over 200,000 characters or containing a NUL stays plain, and any failure (grammar, engine, network) leaves the figure plain without an error.

## Notebook palette, not BB's code theme

Recommendation: the Notebook palette. BB's theme is available (`experimental_useCodeTheme` returns a VS Code theme document), but:

- a user's code theme is chosen against BB's own chrome, and a neon or high-chroma theme would fight a cream page, a serif body and a single yellow accent;
- a figure's rows sit on tints (added, removed, changed word, hovered row) that BB's theme was never checked against, and 4.5:1 can only be promised for a palette whose values this plugin owns;
- the palette must never use the accent yellow, which here means "yours" and "here".

The cost is that Walkthrough code does not follow a user's code theme. The seam to change that is small: tokens carry roles, and a role's colour is one CSS variable (`--wt-tk-<role>`), so a future setting could map a BB theme's scopes onto the same eight variables without touching the tokenizer.

Roles: keyword, string, number (and constants), comment, function, type, property, punctuation, and heading (the type ink, semibold). `src/syntax/notebook-theme.ts` is a TextMate theme whose "colours" are role markers; Shiki resolves scope precedence and the tokenizer reads each marker back as a role.

Inks are in `app.css` (`--wt-tk-*`), light and dark. They are checked by `tests/syntax-palette.test.ts`, which parses `app.css`:

- 4.5:1 or better on the page, the added and removed line tints, a changed word's deeper tint and the hovered-row wash, and on the hover wash over each tint, with removed lines at their reduced opacity;
- under `prefers-contrast: more`, inks are drawn 65% toward the page ink (light and dark) and reach 7:1 on lines, 4.5:1 on the deepest grounds;
- inside a changed word an ink is drawn 35% (light) or 55% (dark) toward the page ink, so a word's tint never costs legibility;
- no ink sits near the accent's hue.

Removed lines recede to 0.88 opacity (from 0.72): at 0.72 the page's own ink only reached 4.8:1 on a changed word, which left no room for any ink.

## Selection, copy and screen readers

Spans add no text, so copy and the figure's "Copy the code" read the same plain text. Row numbers and the "Added:" or "Removed:" labels are `user-select: none`, so a drag across rows holds code only; assistive technology still reads the labels and each row's text.

## Not covered

- Embedded languages other than a Markdown fence's (an HTML `<script>` is coloured by the HTML grammar's own embedding).
- Languages outside the list; add one to `GRAMMARS` and `languages.ts`.
- A figure that begins inside a multi-line construct (an excerpt starting mid-comment) is coloured as if its first line starts clean.
