import { sign, verify, randomUUID, type KeyObject } from "node:crypto";
import { assertSafeHeaders, type RelayIdentity } from "../authorization.ts";

export const LIMITS = Object.freeze({
  frame: 64 * 1024, queue: 1024 * 1024, streams: 16, seen: 4096,
  chunk: 16 * 1024, body: 1024 * 1024, assertion: 8192,
  ttl: 15_000, heartbeat: 15_000, timeout: 45_000,
});
export type Role = "gateway" | "connector";
export interface Keys { gateway: KeyObject; connector: KeyObject; relay: KeyObject }
export interface Binding extends RelayIdentity { gatewayEpoch: string; connectorEpoch: string; id: string }
export type Frame = Binding & (
  | { type: "open"; grantId: string; hostId: string; acquisitionEpoch: number;
      scope: "transport:probe"; method: "GET" | "POST"; target: string;
      mode: "http" | "ws"; body: "signed-ordered-v1"; length: number | null; issuedAt: number; deadline: number }
  | { type: "data"; seq: number; bytes: string; binary: boolean }
  | { type: "ack"; seq: number }
  | { type: "start"; status: 200; protocol: "" | "fixture.v1" }
  | { type: "end"; count: number; code: number; reason: string }
  | { type: "cancel" }
);
export interface Hello extends RelayIdentity { type: "hello"; role: Role; epoch: string; challenge: string }
export interface Challenge extends RelayIdentity { type: "challenge"; challenge: string }
export interface Ready extends RelayIdentity { type: "ready"; epoch: string; connectorEpoch: string; challenge: string }
export type Payload = Frame | Hello | Challenge | Ready;
const token = /^[a-zA-Z0-9_-]{1,128}$/;
export const fresh = () => randomUUID();
export function exact(value: object, keys: string[]): void {
  if (Object.keys(value).sort().join() !== keys.sort().join()) throw new Error("Unexpected fields");
}
export function sameIdentity(a: RelayIdentity, b: RelayIdentity): boolean {
  return a.installationId === b.installationId && a.relayId === b.relayId && a.generation === b.generation;
}
export function seal(payload: Payload, key: KeyObject): string {
  const text = Buffer.from(JSON.stringify({ v: 1, ...payload })).toString("base64url");
  return JSON.stringify({ text, signature: sign(null, Buffer.from(text), key).toString("base64url") });
}
export function unseal(raw: Buffer | string, key: KeyObject, identity: RelayIdentity): Payload {
  if (Buffer.byteLength(raw) > LIMITS.frame) throw new Error("Frame limit");
  const envelope = JSON.parse(raw.toString());
  if (!envelope || typeof envelope !== "object") throw new Error("Envelope");
  exact(envelope, ["text", "signature"]);
  if (typeof envelope.text !== "string" || !/^[A-Za-z0-9_-]+$/.test(envelope.text) ||
      typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]+$/.test(envelope.signature) ||
      !verify(null, Buffer.from(envelope.text), key, Buffer.from(envelope.signature, "base64url"))) throw new Error("Signature");
  const p = JSON.parse(Buffer.from(envelope.text, "base64url").toString("utf8"));
  if (!p || typeof p !== "object" || Array.isArray(p) || p.v !== 1 || !sameIdentity(p, identity) ||
      !token.test(p.installationId) || !token.test(p.relayId) || !Number.isSafeInteger(p.generation) || p.generation < 1) throw new Error("Identity/version");
  const base = ["v", "type", "installationId", "relayId", "generation"];
  if (p.type === "challenge") {
    exact(p, [...base, "challenge"]);
    if (typeof p.challenge !== "string" || !token.test(p.challenge)) throw new Error("Challenge");
  } else if (p.type === "hello") {
    exact(p, [...base, "challenge", "epoch", "role"]);
    if (!["gateway", "connector"].includes(p.role) ||
        ![p.epoch, p.challenge].every((s) => typeof s === "string" && token.test(s))) throw new Error("Hello");
  } else if (p.type === "ready") {
    exact(p, [...base, "challenge", "epoch", "connectorEpoch"]);
    if (![p.epoch, p.connectorEpoch, p.challenge].every((s) => typeof s === "string" && token.test(s))) throw new Error("Ready");
  } else {
    const binding = [...base, "gatewayEpoch", "connectorEpoch", "id"];
    if (![p.gatewayEpoch, p.connectorEpoch, p.id].every((s) => typeof s === "string" && token.test(s))) throw new Error("Stream binding");
    switch (p.type) {
      case "open":
        exact(p, [...binding, "grantId", "hostId", "acquisitionEpoch", "scope", "method", "target", "mode", "body", "length", "issuedAt", "deadline"]);
        if (![p.grantId, p.hostId].every((s) => typeof s === "string" && token.test(s)) ||
            !Number.isSafeInteger(p.acquisitionEpoch) || p.acquisitionEpoch < 1 || p.scope !== "transport:probe" || p.body !== "signed-ordered-v1" ||
            !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.deadline)) throw new Error("Open claims");
        route(p.method, p.target, p.mode, p.length);
        if (Buffer.byteLength(raw) > LIMITS.assertion) throw new Error("Open limit");
        break;
      case "data":
        exact(p, [...binding, "seq", "bytes", "binary"]);
        if (!Number.isSafeInteger(p.seq) || p.seq < 0 || typeof p.bytes !== "string" ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.bytes) ||
            typeof p.binary !== "boolean" || Buffer.from(p.bytes, "base64").length > LIMITS.chunk) throw new Error("Data");
        break;
      case "ack":
        exact(p, [...binding, "seq"]);
        if (!Number.isSafeInteger(p.seq) || p.seq < 0) throw new Error("Ack");
        break;
      case "start":
        exact(p, [...binding, "status", "protocol"]);
        if (p.status !== 200 || !["", "fixture.v1"].includes(p.protocol)) throw new Error("Start");
        break;
      case "end":
        exact(p, [...binding, "count", "code", "reason"]);
        if (!Number.isSafeInteger(p.count) || p.count < 0 || p.count > LIMITS.body ||
            !Number.isSafeInteger(p.code) || !validClose(p.code) ||
            typeof p.reason !== "string" || Buffer.byteLength(p.reason) > 123) throw new Error("End");
        break;
      case "cancel": exact(p, binding); break;
      default: throw new Error("Unknown frame");
    }
  }
  const { v: _, ...payload } = p;
  return payload as Payload;
}
export function validClose(code: number): boolean {
  return [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code) || code >= 3000 && code <= 4999;
}
export function route(method: string, target: string, mode: string, length: number | null): void {
  const allowed = mode === "ws" ? method === "GET" && target === "/v1/fixture/ws" && length === null :
    mode === "http" && Number.isSafeInteger(length) && length! >= 0 && length! <= LIMITS.body && (
      method === "GET" && ["/v0/probe", "/v1/fixture/bytes", "/v1/fixture/hold"].includes(target) && length === 0 ||
      method === "POST" && ["/v1/fixture/echo", "/v1/fixture/mutate"].includes(target));
  if (!allowed) throw new Error("Fixture route only");
}
export function safeHeaders(headers: Headers): void {
  assertSafeHeaders(headers);
  for (const name of headers.keys()) {
    if (name.startsWith("x-bb-") || ["proxy-authorization", "transfer-encoding", "trailer", "expect"].includes(name)) throw new Error("Unsupported header");
  }
}
export function localRelay(url: string): void {
  if (!/^ws:\/\/127\.0\.0\.1:[0-9]+\/tunnel$/.test(url)) throw new Error("Local dedicated relay fixture only");
}
export function binding(f: Binding): Binding {
  return { installationId: f.installationId, relayId: f.relayId, generation: f.generation,
    gatewayEpoch: f.gatewayEpoch, connectorEpoch: f.connectorEpoch, id: f.id };
}
export function isFrame(p: Payload): p is Frame { return "id" in p; }
