// Measures, against a running BB with real models, when the pane first shows words.
// usage: node paint.mjs <label>   (spawns a scratch thread in the daily BB, opens the pane page as soon as the record exists, samples the DOM every 250ms)
import puppeteer from "puppeteer-core"; // not a dependency of the plugin: install it next to this script
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
const label = process.argv[2];
const PROJECT = process.env.UAT_PROJECT, REPO = process.env.UAT_REPO, SERVER = process.env.BB_SERVER_URL, DB = process.env.WT_DB ?? `${process.env.HOME}/.bb/plugins/walkthrough/data.db`;
if (!SERVER || !PROJECT || !REPO) throw new Error("set BB_SERVER_URL, UAT_PROJECT (a scratch project id) and UAT_REPO (its repository, with uncommitted changes)");
const flags = "--provider pi --model vercel-ai-gateway/anthropic/claude-opus-5.5 --reasoning-level xhigh".split(" ");
const t0 = Date.now();
const out = JSON.parse(execFileSync("bb", ["thread", "spawn", ...flags, "--project", PROJECT, "--environment", REPO, "--title", `uat4-ux ${label}`, "--json", "--prompt", "Give me a walkthrough of my uncommitted changes in this repo (staged and unstaged)."]).toString());
const tid = out.id;
const db = new Database(DB, { readonly: true });
let row; while (!(row = db.prepare("select id, created_at from walkthroughs_v2 where thread_id=? order by created_at desc limit 1").get(tid))) await new Promise((r) => setTimeout(r, 100));
const tRecord = Date.now() - t0;
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", userDataDir: `${process.env.TMPDIR ?? "/tmp"}/wt-latency-chrome`, args: ["--no-sandbox"] });
const page = await browser.newPage(); await page.setViewport({ width: 480, height: 900 });
const nav = page.goto(`${SERVER}/plugins/walkthrough/walkthroughs/${row.id}`, { waitUntil: "domcontentloaded" });
const samples = []; let done = false;
const state = () => page.evaluate(() => { const w = document.querySelector(".wt"); if (!w) return null; const prose = document.querySelector(".wt-prose"); const skel = !!document.querySelector(".wt-skeleton"); const work = document.querySelector(".wt-working, .wt-pulse, [role=status].wt-muted")?.textContent || ""; return { prose: (prose?.textContent || "").trim().length, skel, work: work.slice(0, 40), figure: !!document.querySelector(".wt-figure:not(.wt-skel-figure)"), label: document.querySelector(".wt-chip")?.textContent?.slice(0, 20) || "" }; }).catch(() => null);
const end = Date.now() + 110000;
let ready = null, firstWords = null, firstSkel = null, firstLive = null, part1 = null;
while (Date.now() < end) {
  const t = Date.now() - t0; const s = await state();
  if (s) { if (ready === null) ready = t; if (firstSkel === null && s.skel) firstSkel = t; if (firstLive === null && s.work) firstLive = t; if (firstWords === null && s.prose > 0) firstWords = t; if (part1 === null && s.figure) { part1 = t; } samples.push([t, s.prose, s.skel ? 1 : 0, s.work]); }
  if (part1 !== null) break;
  await new Promise((r) => setTimeout(r, 250));
}
const rec = db.prepare("select json_extract(data,'$.timing') as t, created_at from walkthroughs_v2 where id=?").get(row.id);
const tm = JSON.parse(rec.t || "{}");
const abs = Object.fromEntries(Object.entries(tm).map(([k, v]) => [k, +((rec.created_at + v - t0) / 1000).toFixed(1)]));
console.log(JSON.stringify({ label, record: +(tRecord / 1000).toFixed(1), paneReady: ready && +(ready / 1000).toFixed(1), firstSkeleton: firstSkel && +(firstSkel / 1000).toFixed(1), firstLiveLine: firstLive && +(firstLive / 1000).toFixed(1), firstWordsInDom: firstWords && +(firstWords / 1000).toFixed(1), part1InDom: part1 && +(part1 / 1000).toFixed(1), server: abs }));
await browser.close();
