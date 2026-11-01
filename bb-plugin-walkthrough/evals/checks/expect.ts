// A thrown assertion is the failure; these keep the reports readable.
import assert from "node:assert/strict";

export function equal<T>(actual: T, expected: T, what: string): void {
  assert.deepEqual(actual, expected, `${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

export function ok(value: unknown, what: string): void {
  assert.ok(value, what);
}

export function includes(text: string, needle: string, what: string): void {
  assert.ok(text.includes(needle), `${what}: ${JSON.stringify(needle)} not found in ${JSON.stringify(text.slice(0, 400))}`);
}

export function excludes(text: string, needle: string, what: string): void {
  assert.ok(!text.includes(needle), `${what}: ${JSON.stringify(needle)} should not appear`);
}
