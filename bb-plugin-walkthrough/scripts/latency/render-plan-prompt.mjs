const [dir, out] = process.argv.slice(2);
const w = await import(dir + "/worker.ts");
const wt = { id: "wt_x", request: "Give me a walkthrough of my uncommitted changes in this repo (staged and unstaged).", parts: [], mode: "local" };
const brief = "Working tree right now, against HEAD: 2 staged, 1 unstaged, 0 untracked.\n- modified: src/queue.ts (+8 -1; unstaged)\n- modified: src/retry.ts (+18 -7; staged)\n- added: test/retry.test.ts (+6 -0; staged)\nStaged changes are uncommitted work like any other: `git diff HEAD` shows staged and unstaged edits together.";
const text = [w.PLAN_INSTRUCTIONS, "", w.planMessage(wt, brief), "", "(This is a timing test: the walkthrough_* tools are not available. Do the plan turn up to and including the one streamed message holding the introduction, the `part: 1` fence and part 1, then end your turn. Do not call any walkthrough tool.)"].join("\n");
(await import("node:fs")).writeFileSync(out, text);
console.log(out, text.length);
