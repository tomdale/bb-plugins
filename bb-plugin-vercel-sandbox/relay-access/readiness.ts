import { ACCESS_HEADER, TESTED_CORE } from "./policy.ts";
import { networkReason, report, type DiagnosticSink } from "./diagnostics.ts";

/** Observes only the fixed machine version route; response content never enters diagnostics. */
export async function probeVersion(options: { origin: string | URL; token: string; signal: AbortSignal; attempt: number; diagnostics?: DiagnosticSink }): Promise<boolean> {
  const timeout = AbortSignal.timeout(1000);
  let status: number | undefined;
  report(options.diagnostics, "version-probe", "pending", "none", { attempts: options.attempt });
  try {
    const response = await fetch(new URL("/install/version", options.origin), {
      headers: { [ACCESS_HEADER]: options.token }, redirect: "error", signal: AbortSignal.any([options.signal, timeout]),
    });
    status = response.status;
    const details = { httpStatus: status, attempts: options.attempt };
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      report(options.diagnostics, "version-probe", "failed", response.status === 401 || response.status === 403 ? "http-denied" : "http-status", details);
      return false;
    }
    if (!response.body) { report(options.diagnostics, "version-probe", "failed", "invalid-body", details); return false; }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 4096) {
          await reader.cancel().catch(() => {});
          report(options.diagnostics, "version-probe", "failed", "body-limit", details);
          return false;
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { report(options.diagnostics, "version-probe", "failed", "invalid-json", details); return false; }
    if (!value || typeof value !== "object" || !("version" in value) || !("protocolVersion" in value)) {
      report(options.diagnostics, "version-probe", "failed", "invalid-body", details); return false;
    }
    if (value.version !== TESTED_CORE.version) { report(options.diagnostics, "version-probe", "failed", "version-mismatch", details); return false; }
    if (value.protocolVersion !== TESTED_CORE.protocolVersion) { report(options.diagnostics, "version-probe", "failed", "protocol-mismatch", details); return false; }
    report(options.diagnostics, "version-probe", "verified", "none", details);
    return true;
  } catch (error) {
    if (options.signal.aborted) { report(options.diagnostics, "version-probe", "closed", "cancelled", { httpStatus: status, attempts: options.attempt }); options.signal.throwIfAborted(); }
    const cause = error && typeof error === "object" && "cause" in error ? error.cause : error;
    report(options.diagnostics, "version-probe", "failed", timeout.aborted ? "timeout" : networkReason(cause), { httpStatus: status, attempts: options.attempt });
    return false;
  }
}
