// A TextMate theme whose "colours" are role markers. Shiki resolves scope
// precedence (deepest scope first, then the longer selector), so the mapping
// below stays a short list of scope prefixes; the tokenizer reads each token's
// marker back as a role (`roleOfColor`) and never exposes a colour.
import type { ThemeRegistrationRaw } from "shiki/core";
import { ROLES, type Role } from "./roles.ts";

const marker = (role: Role) => `#7a00${(ROLES.indexOf(role) + 16).toString(16)}`;
const PLAIN = "#000000";

const MARKER_ROLE = new Map<string, Role>(ROLES.map((role) => [marker(role), role]));
/** The role a theme colour stands for, or null for plain text. */
export const roleOfColor = (color: string | undefined): Role | null => (color ? (MARKER_ROLE.get(color.toLowerCase()) ?? null) : null);

// A punctuation mark that opens a string, comment or heading takes that parent's
// ink because its own scope (`punctuation.definition.string…`) is listed under it.
const RULES: Record<Role, string[]> = {
  comment: ["comment", "punctuation.definition.comment", "meta.diff.header", "meta.separator.diff"],
  string: [
    "string", "punctuation.definition.string", "markup.inline.raw", "markup.raw", "markup.fenced_code", "markup.quote",
    "constant.character.escape", "punctuation.definition.raw",
  ],
  // Constants share the number's ink: a literal value, however it is spelled.
  number: [
    "constant.numeric", "constant.language", "constant.other.color", "support.constant", "constant.other.caps", "meta.diff.range",
    "keyword.other.unit",
  ],
  keyword: [
    "keyword", "storage", "variable.language", "entity.name.tag", "keyword.operator.new", "keyword.operator.delete",
    "keyword.operator.typeof", "keyword.operator.instanceof", "keyword.operator.in", "keyword.operator.of", "keyword.operator.expression",
    "keyword.operator.logical.python", "keyword.operator.word", "keyword.control",
  ],
  function: [
    "entity.name.function", "support.function", "meta.function-call", "variable.function", "entity.name.decorator", "meta.decorator",
    "punctuation.decorator", "markup.underline.link", "string.other.link", "entity.name.macro", "support.macro",
  ],
  type: [
    "entity.name.type", "entity.name.class", "entity.name.namespace", "entity.other.inherited-class", "support.type", "support.class",
    "storage.type.primitive", "storage.type.numeric", "storage.type.built-in", "entity.name.lifetime", "storage.modifier.lifetime",
    "entity.name.trait", "entity.name.interface", "entity.name.enum",
  ],
  property: [
    "support.type.property-name", "punctuation.support.type.property-name", "meta.object-literal.key", "variable.other.property", "variable.other.object.property",
    "support.variable.property", "entity.other.attribute-name", "variable.other.member", "meta.property-name", "entity.name.tag.yaml",
    "support.type.vendored.property-name", "meta.structure.dictionary.key", "variable.object.property", "variable.other.enummember",
  ],
  punctuation: ["punctuation", "keyword.operator", "meta.brace", "meta.delimiter"],
  heading: ["markup.heading", "entity.name.section", "markup.bold", "punctuation.definition.heading"],
};

// Code inside a string (a template's `${…}`) or a Markdown fence is code again, whatever string or block it sits in.
const PLAIN_SCOPES = ["meta.template.expression", "meta.embedded", "meta.interpolation", "source.ts.embedded.html"];

export const NOTEBOOK_THEME: ThemeRegistrationRaw = {
  name: "notebook",
  type: "light",
  fg: PLAIN,
  bg: "#ffffff",
  settings: [
    { settings: { foreground: PLAIN } },
    { scope: PLAIN_SCOPES, settings: { foreground: PLAIN } },
    ...(Object.entries(RULES) as Array<[Role, string[]]>).map(([role, scope]) => ({ scope, settings: { foreground: marker(role) } })),
  ],
};
