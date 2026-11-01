// The committed fixtures the two layers read: recorded helper messages with the
// format verdict each one must get, and recorded live runs replayed through the
// gate. Fixtures are JSON plus plain text so a person can add a recording
// without touching code.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GatedRun, Thresholds } from "../live/gate.ts";
import { scoreFormat } from "../scorer/format-score.ts";

const EVALS = new URL("../", import.meta.url);
const path = (from: URL, relative: string): string => fileURLToPath(new URL(relative, from));
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

export interface MessageFixture {
  file: string;
  provenance: string;
  expect: Record<string, unknown>;
}

export function messageFixtures(): MessageFixture[] {
  return readJson<{ messages: MessageFixture[] }>(path(EVALS, "fixtures/messages/index.json")).messages;
}

export function messageText(file: string): string {
  return readFileSync(path(EVALS, `fixtures/messages/${file}`), "utf8");
}

export interface RecordedRun extends GatedRun {
  formatFixture: string | null;
  expectFailures: string[];
}

/** The recorded runs, with each one's format verdict taken from its message fixture. */
export function recordedRuns(): RecordedRun[] {
  return readJson<{ runs: Array<Omit<RecordedRun, "format">> }>(path(EVALS, "fixtures/recorded-runs.json")).runs.map((run) => ({
    ...run,
    format: run.formatFixture === null ? null : scoreFormat(messageText(run.formatFixture)),
  }));
}

export function thresholds(): Thresholds {
  return readJson<Thresholds>(path(EVALS, "thresholds.json"));
}
