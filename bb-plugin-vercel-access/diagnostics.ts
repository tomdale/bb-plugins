export const diagnosticStages = ["local-core", "tls", "wss", "ssh-host", "ssh-auth", "reverse", "version-probe", "readiness"] as const;
export const diagnosticStates = ["not-started", "pending", "verified", "failed", "closed"] as const;
export const diagnosticReasons = [
  "none", "disabled", "invalid-config", "unsupported-core", "core-unreachable", "core-check-failed", "connection-refused", "connection-reset", "dns-failure",
  "tls-certificate", "tls-handshake", "network-error", "upgrade-denied", "peer-closed", "timeout", "host-pin-mismatch", "ssh-auth-rejected",
  "ssh-handshake", "reverse-rejected", "http-denied", "http-status", "body-limit", "invalid-json", "invalid-body", "version-mismatch",
  "protocol-mismatch", "cancelled", "disposed", "transport-lost", "probe-exhausted",
] as const;
export type DiagnosticStage = typeof diagnosticStages[number];
export type DiagnosticState = typeof diagnosticStates[number];
export type DiagnosticReason = typeof diagnosticReasons[number];
export interface DiagnosticRecord {
  generation: number; stage: DiagnosticStage; state: DiagnosticState; reason: DiagnosticReason; httpStatus: number | null; attempts: number;
}
export interface DiagnosticSnapshot { version: 1; generation: number; stages: DiagnosticRecord[]; firstFailure: DiagnosticRecord | null }
export type DiagnosticSink = (stage: DiagnosticStage, state: DiagnosticState, reason?: DiagnosticReason, details?: { httpStatus?: number; attempts?: number }) => void;
const bounded = (value: unknown, maximum: number) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
export const httpStatus = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;

/** Fixed-size local state, not an error/event log. Extra caller properties never enter snapshots. */
export class DiagnosticStore {
  private generation = 0;
  private records = new Map<DiagnosticStage, DiagnosticRecord>();
  private firstFailure: DiagnosticRecord | null = null;
  begin() { this.generation = Math.min(this.generation + 1, 65535); this.records.clear(); }
  readonly record: DiagnosticSink = (stage, state, reason = "none", details = {}) => {
    if (!diagnosticStages.includes(stage)) return;
    const safeState = diagnosticStates.includes(state) ? state : "failed";
    const safeReason = diagnosticReasons.includes(reason) ? reason : "network-error";
    const item: DiagnosticRecord = { generation: this.generation, stage, state: safeState, reason: safeReason, httpStatus: httpStatus(details.httpStatus), attempts: bounded(details.attempts, 20) };
    this.records.set(stage, item);
    if (safeState === "failed" && this.firstFailure?.generation !== this.generation) this.firstFailure = item;
    if (stage === "readiness" && safeState === "verified") this.firstFailure = null;
  };
  snapshot(): DiagnosticSnapshot {
    return { version: 1, generation: this.generation, stages: diagnosticStages.map(stage => ({ ...(this.records.get(stage) ?? { generation: this.generation, stage, state: "not-started", reason: "none", httpStatus: null, attempts: 0 }) })), firstFailure: this.firstFailure ? { ...this.firstFailure } : null };
  }
}

/** Diagnostic callbacks are observational and cannot interrupt cleanup or change admission. */
export function report(sink: DiagnosticSink | undefined, stage: DiagnosticStage, state: DiagnosticState, reason: DiagnosticReason = "none", details?: { httpStatus?: number; attempts?: number }) {
  try { sink?.(stage, state, reason, details); } catch {}
}

export function networkReason(error: unknown): DiagnosticReason {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (typeof code !== "string") return "network-error";
  if (["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)) return "tls-certificate";
  if (code.startsWith("ERR_SSL_") || code.startsWith("ERR_TLS_")) return "tls-handshake";
  if (code === "ECONNREFUSED") return "connection-refused";
  if (code === "ECONNRESET") return "connection-reset";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns-failure";
  if (code === "ETIMEDOUT") return "timeout";
  return "network-error";
}

export const admissionReasons = ["route", "http-version", "duplicate-header", "unlisted-header", "header-value", "host-mismatch", "fetch-metadata", "admission", "framing", "artifact-condition", "body-metadata", "upgrade", "connection", "capacity", "policy"] as const;
export type AdmissionReason = typeof admissionReasons[number];
export const routeCategories = ["version", "installer", "enrollment", "session", "artifact", "native-ws", "connector", "unlisted"] as const;
export type RouteCategory = typeof routeCategories[number];
export const methodCategories = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "CONNECT", "OTHER"] as const;
export type MethodCategory = typeof methodCategories[number];
export interface AdmissionObservation { reason: AdmissionReason; headerNames: string[]; route: RouteCategory; method: MethodCategory; status: number | null; hostMatches: boolean }
export interface AdmissionSnapshot { version: 1; count: number; suppressed: number; last: AdmissionObservation | null }
export class AdmissionDenied extends Error {
  readonly reason: AdmissionReason;
  readonly headerNames: string[];
  constructor(reason: AdmissionReason, headerNames: string[] = []) { super("Machine policy denied request"); this.reason = reason; this.headerNames = headerNames; }
}
const safeHeaderNames = (names: string[]) => [...new Set((Array.isArray(names) ? names : []).slice(0, 8).filter(name => typeof name === "string" && name === name.trim() && /^[a-z][a-z0-9-]{0,63}$/.test(name)))].sort();

/** At most eight observations per second and 32 per process; only the last bounded record is retained. */
export class AdmissionDiagnostics {
  private state: AdmissionSnapshot = { version: 1, count: 0, suppressed: 0, last: null };
  private window = -1;
  private windowCount = 0;
  private readonly changed?: (snapshot: AdmissionSnapshot) => void;
  private readonly now: () => number;
  constructor(changed?: (snapshot: AdmissionSnapshot) => void, now = Date.now) { this.changed = changed; this.now = now; }
  record(event: AdmissionObservation) {
    const window = Math.floor(this.now() / 1000);
    if (window !== this.window) { this.window = window; this.windowCount = 0; }
    if (this.state.count >= 32 || this.windowCount >= 8) { this.state.suppressed = Math.min(65535, this.state.suppressed + 1); return; }
    this.windowCount++;
    this.state.count++;
    this.state.last = { reason: admissionReasons.includes(event.reason) ? event.reason : "policy", headerNames: safeHeaderNames(event.headerNames), route: routeCategories.includes(event.route) ? event.route : "unlisted", method: methodCategories.includes(event.method) ? event.method : "OTHER", status: httpStatus(event.status), hostMatches: event.hostMatches === true };
    try { this.changed?.(this.snapshot()); } catch {}
  }
  snapshot(): AdmissionSnapshot { return { ...this.state, last: this.state.last ? { ...this.state.last, headerNames: [...this.state.last.headerNames] } : null }; }
}
