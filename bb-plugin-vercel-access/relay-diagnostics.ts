import { writeFile, rename } from "node:fs/promises";
import { AdmissionDiagnostics, type AdmissionSnapshot } from "./diagnostics.ts";

/** A fixed private status file, not stdout/stderr or a request log. Writes are bounded by the collector. */
export function relayDiagnosticFile(hostKeyFile: string) {
  const path = `${hostKeyFile}.diagnostics.json`;
  let pending: Promise<void> = Promise.resolve();
  const write = (snapshot: AdmissionSnapshot) => {
    const text = JSON.stringify(snapshot);
    if (Buffer.byteLength(text) > 4096) return;
    pending = pending.then(async () => {
      await writeFile(`${path}.tmp`, text, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    }).catch(() => {});
  };
  const diagnostics = new AdmissionDiagnostics(write);
  write(diagnostics.snapshot());
  return { diagnostics, async flush() { await pending; } };
}
