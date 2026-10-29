import type { IncomingMessage } from "node:http";
import { AdmissionDenied, type RouteCategory } from "./diagnostics.ts";

export const ACCESS_HEADER = "x-vercel-access";
export const DAEMON_PROTOCOL = "bb-host-daemon.v1";
export const MAX_BODY = 1024 * 1024;
export const MAX_RESPONSE = 256 * 1024 * 1024;
export const MAX_CONNECTIONS = 32;
export const TESTED_CORE = { version: "0.46.1", protocolVersion: 244 } as const;

type Route = "http" | "ws";
const getRoutes = new Set(["/install.sh", "/install.ps1", "/install/version", "/install/bb-app.tgz"]);
const postRoutes = new Set([
  "/internal/hosts/enroll", "/internal/session/open", "/internal/session/events",
  "/internal/session/tool-call", "/internal/session/interactive-request",
  "/internal/session/interactive-request/interrupt",
]);

/*
 * This is a dispatch boundary, not a BB identity verifier. Never normalize a
 * path before admission: BB must receive exactly the one target we checked.
 */
export function route(method: string, target: string): Route | null {
  if (target.length > 8192 || !/^[\x21-\x7e]+$/.test(target) || /[\\#]/.test(target)) return null;
  if (method === "GET" && /^\/internal\/ws\?sessionId=[A-Za-z0-9_-]{1,128}$/.test(target)) return "ws";
  if (target.includes("?")) {
    if (method !== "GET" || !target.startsWith("/internal/session/project-attachment-content?")) return null;
    const query = target.slice(target.indexOf("?") + 1);
    const params = new URLSearchParams(query);
    const keys = ["sessionId", "threadId", "projectId", "path"];
    if (params.size !== 4 || keys.some(key => params.getAll(key).length !== 1 || !params.get(key))) return null;
    if ([...params.keys()].some(key => !keys.includes(key)) || params.toString() !== query) return null;
    return "http";
  }
  if (method === "POST" && postRoutes.has(target)) return "http";
  if (method !== "GET") return null;
  if (getRoutes.has(target)) return "http";
  if (/^\/internal\/skills\/tree\/[a-f0-9]{64}$/.test(target)) return "http";
  if (/^\/internal\/plugins\/[a-z0-9]+(?:-+[a-z0-9]+)*\/host\/[a-f0-9]{64}$/.test(target)) return "http";
  return null;
}

export function routeCategory(method: string, target: string): RouteCategory {
  if (!route(method, target)) return "unlisted";
  if (target === "/install/version") return "version";
  if (target.startsWith("/install")) return "installer";
  if (target === "/internal/hosts/enroll") return "enrollment";
  if (route(method, target) === "ws") return "native-ws";
  if (target.startsWith("/internal/session/")) return "session";
  return "artifact";
}

const commonHeaders = new Set([
  "host", ACCESS_HEADER, "authorization", "content-type", "content-length",
  "if-none-match", "accept", "accept-encoding", "accept-language", "sec-fetch-mode", "user-agent", "connection",
]);
const wsHeaders = new Set(["upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]);

const discardedPlatformHeaders = new Set(["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "x-vercel-id", "x-vercel-forwarded-for"]);

export function admitRequest(req: IncomingMessage, authority: string, upgrade: boolean, discardPlatformMetadata = false): {
  token: string; target: string; headers: Record<string, string>; length: number;
} {
  const target = req.url ?? "";
  if (req.httpVersion !== "1.1") throw new AdmissionDenied("http-version");
  if (route(req.method ?? "", target) !== (upgrade ? "ws" : "http")) throw new AdmissionDenied("route");
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    const value = req.rawHeaders[i + 1];
    if (seen.has(name)) throw new AdmissionDenied("duplicate-header", [name]);
    if (!commonHeaders.has(name) && !(upgrade && wsHeaders.has(name)) && !(discardPlatformMetadata && (discardedPlatformHeaders.has(name) || name.startsWith("x-vercel-")))) throw new AdmissionDenied("unlisted-header", [name]);
    if (value.length > 8192 || /[^\x20-\x7e]/.test(value)) throw new AdmissionDenied("header-value", [name]);
    seen.add(name);
    headers[name] = value;
  }
  if (headers.host !== authority) throw new AdmissionDenied("host-mismatch", ["host"]);
  // Node's native fetch adds these browser-shaped fields. They are inert
  // metadata, not authority, and are discarded rather than forwarded to core.
  if (headers["accept-language"] !== undefined && headers["accept-language"] !== "*") throw new AdmissionDenied("fetch-metadata", ["accept-language"]);
  if (headers["sec-fetch-mode"] !== undefined && headers["sec-fetch-mode"] !== "cors") throw new AdmissionDenied("fetch-metadata", ["sec-fetch-mode"]);
  const token = headers[ACCESS_HEADER];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AdmissionDenied("admission");
  const length = headers["content-length"] === undefined ? 0 : Number(headers["content-length"]);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY || (headers["content-length"] !== undefined && String(length) !== headers["content-length"])) throw new AdmissionDenied("framing");
  if (headers["if-none-match"] !== undefined && (req.method !== "GET" || target !== "/install/bb-app.tgz" || !/^"sha256-[a-f0-9]{64}"$/.test(headers["if-none-match"]))) throw new AdmissionDenied("artifact-condition");
  if (req.method === "POST") {
    if (!seen.has("content-length") || headers["content-type"] !== "application/json") throw new AdmissionDenied("body-metadata");
  } else if (length !== 0) throw new AdmissionDenied("framing");
  if (upgrade) {
    if (headers["sec-websocket-extensions"] !== undefined && headers["sec-websocket-extensions"] !== "permessage-deflate; client_max_window_bits") throw new AdmissionDenied("upgrade");
    if (headers.upgrade?.toLowerCase() !== "websocket" || headers.connection?.toLowerCase() !== "upgrade" ||
        headers["sec-websocket-protocol"] !== DAEMON_PROTOCOL || headers["sec-websocket-version"] !== "13" ||
        !/^[A-Za-z0-9+/]{22}==$/.test(headers["sec-websocket-key"] ?? "")) throw new AdmissionDenied("upgrade");
  } else if (headers.connection && !["close", "keep-alive"].includes(headers.connection.toLowerCase())) throw new AdmissionDenied("connection");
  // No caller authority, cookies, forwarding metadata, enrollment lookup or
  // transport credential reaches core; native Authorization stays opaque.
  const native: Record<string, string> = {};
  for (const name of ["authorization", "content-type", "content-length", "accept", "user-agent", "if-none-match"]) {
    if (headers[name] !== undefined) native[name] = headers[name];
  }
  native["accept-encoding"] = "identity";
  return { token, target, headers: native, length };
}
