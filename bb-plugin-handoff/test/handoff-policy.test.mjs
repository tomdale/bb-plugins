import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skill = await readFile(new URL("../skills/handoff/SKILL.md", import.meta.url), "utf8");
const classify = skill.split("## 1. Classify the handoff\n")[1]?.split("## 2. Spawn the successor\n")[0];
const finish = skill.split("## 3. Finish this thread's part\n")[1];
assert.ok(classify, "classification section exists");
assert.ok(finish, "finish section exists");

const delegation = finish.split("Takeover, where the successor owns the current primary task:")[0];
const takeover = finish.split("Takeover, where the successor owns the current primary task:")[1];
assert.ok(takeover, "takeover section exists");

test("ownership classification separates a primary-task takeover from tangential delegation", () => {
  assert.match(classify, /a takeover transfers the current primary task/);
  assert.match(classify, /a\s+delegation transfers tangential work while this thread keeps its primary task/);
  assert.match(classify, /Ask the user when the instruction does not make that distinction clear/);
});

test("tangential delegation keeps the source open and proposes resuming primary work", () => {
  assert.match(delegation, /leave this thread open/);
  assert.match(delegation, /primary task stays here/);
  assert.match(delegation, /propose resuming it with the next concrete step/);
});

test("primary-task takeover can archive when no major work remains", () => {
  assert.match(takeover, /If none\s+remain, make this thread's share durable, then archive it/);
  assert.match(takeover, /For a takeover with no remaining major work, finish these steps before\narchiving/);
  assert.match(takeover, /Run `bb thread archive --self`/);
});

test("remaining or unclear major work keeps the source open until ownership is resolved", () => {
  assert.match(takeover, /If any remain or\ntheir ownership is unclear, leave this thread open and ask the user/);
  assert.match(takeover, /Archive only when\nall major work has an owner and this thread has none/);
});
