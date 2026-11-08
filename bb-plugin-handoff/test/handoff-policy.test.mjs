import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skill = await readFile(new URL("../skills/handoff/SKILL.md", import.meta.url), "utf8");

/** Section text with wrapping collapsed, so assertions read as whole sentences. */
const flat = (text) => text.replace(/\s+/g, " ").trim();
const section = (from, to) =>
  flat(
    skill
      .split(`## ${from}\n`)[1]
      ?.split(to ? `## ${to}\n` : undefined)[0] ?? "",
  );

const scope = section("1. Scope and classify the handoff", "2. Spawn the successor");
const spawn = section("2. Spawn the successor", "3. Finish this thread's part");
const finish = skill.split("## 3. Finish this thread's part\n")[1];
assert.ok(scope, "scope section exists");
assert.ok(spawn, "spawn section exists");
assert.ok(finish, "finish section exists");

const takeoverMarker = "Takeover, where the successor owns the work this thread was chartered to do:";
const delegation = flat(finish.split(takeoverMarker)[0]);
const takeover = flat(finish.split(takeoverMarker)[1] ?? "");
assert.ok(takeover, "takeover section exists");

test("classification separates a primary-task takeover from tangential delegation", () => {
  assert.match(scope, /A takeover moves the work this thread was chartered to do/);
  assert.match(scope, /a delegation moves tangential work while this thread keeps its primary task/);
  assert.match(scope, /Ask the user when the split does not settle it/);
});

test("a two-item instruction moves only the item the handoff phrase names", () => {
  assert.match(scope, /List its work items and give each an owner: the successor, or this thread/);
  assert.match(scope, /The phrase that hands work off .* names the item or items that move/);
  assert.match(scope, /Sequencing words around that phrase name the items that stay: "before beginning", "first … then", "while I …", "after that"/);
  assert.match(scope, /Work the same message asks for beside the handoff phrase stays here/);
});

test("an ambiguous split goes to the user before anything is spawned", () => {
  assert.match(scope, /Ask the user which items move when the handoff phrase could attach to more than one/);
  assert.match(scope, /when the instruction could hand off one item or all of them/);
  assert.match(scope, /State the split in one line before spawning/);
});

test("the successor prompt carries the marker phrase and the work that stays", () => {
  assert.match(spawn, /the user's handoff instruction verbatim, keeping the phrase that marks the moving item/);
  assert.match(spawn, /the items that stay here, so the successor leaves them alone/);
  assert.match(spawn, /a takeover successor owns the work this thread was chartered to do and its publish/);
});

test("tangential delegation keeps the source open and proposes resuming primary work", () => {
  assert.match(delegation, /leave this thread open/);
  assert.match(delegation, /primary task stays here/);
  assert.match(delegation, /propose resuming it with the next concrete step/);
});

test("takeover remaining work covers the split and work the instruction never named", () => {
  assert.match(takeover, /the split's items that stay here and any planned work the instruction never named/);
  assert.match(takeover, /If none remain, make this thread's share durable, then archive it/);
  assert.match(takeover, /For a takeover with no remaining major work, finish these steps before archiving/);
  assert.match(takeover, /Run `bb thread archive --self`/);
});

test("remaining or unclear major work keeps the source open until ownership is resolved", () => {
  assert.match(takeover, /If any remain or their ownership is unclear, leave this thread open and ask the user/);
  assert.match(takeover, /Archive only when all major work has an owner and this thread has none/);
});
