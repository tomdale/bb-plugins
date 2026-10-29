import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { AdmissionLeases } from "./grants.ts";
import { openBridge, openRelayAdapter } from "./bridge.ts";
import { openTunnelRelay, startConnector, hostFingerprint } from "./tunnel.ts";
import { syntheticKeys } from "./integration/keys.ts";
import { freePort } from "./integration/isolated.ts";
import { ACCESS_HEADER, TESTED_CORE } from "./policy.ts";

const delayMs = Number(process.env.BB_TEST_OPERATION_DELAY_MS ?? 18_500);
if (!Number.isInteger(delayMs) || delayMs < 18_000 || delayMs > 180_000) throw new Error("Expected bounded 18–180 second conformance delay");
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise: Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Cancellation cleanup deadline exceeded")), 5000); })]); }
  finally { clearTimeout(timer); }
}

test(`admitted async responses survive ${delayMs}ms through direct and SSH surfaces`, { concurrency: 2, timeout: delayMs + 20_000 }, async t => {
  await Promise.all(["direct", "ssh-ws"].map(mode => t.test(mode, async t => {
    const started = { steady: deferred(), cancel: deferred(), revoke: deferred() };
    const canceled = { cancel: deferred(), revoke: deferred() };
    let nativeOperations = 0;
    const native = createServer((req, res) => {
      if (req.url === "/install/version") { res.end(JSON.stringify(TESTED_CORE)); return; }
      const kind = req.headers["user-agent"] as keyof typeof started;
      if (!Object.hasOwn(started, kind)) { res.writeHead(400); res.end(); return; }
      nativeOperations++; req.resume(); started[kind].resolve();
      const timer = setTimeout(() => res.end("synthetic async native result"), delayMs);
      res.once("close", () => { clearTimeout(timer); if (kind !== "steady" && !res.writableEnded) canceled[kind].resolve(); });
    });
    native.listen(0, "127.0.0.1"); await once(native, "listening");
    t.after(async () => { native.closeAllConnections(); await new Promise<void>(resolve => native.close(() => resolve())); });
    const leases = new AdmissionLeases();
    const bridge = await openBridge({ baseUrl: `http://127.0.0.1:${(native.address() as { port: number }).port}`, leases }); t.after(() => bridge.close());
    let machineUrl = bridge.url;
    let connector: Awaited<ReturnType<typeof startConnector>> | undefined;
    if (mode === "ssh-ws") {
      const host = syntheticKeys(); const client = syntheticKeys();
      const reversePort = await freePort(); const publicPort = await freePort(); const bridgePort = Number(new URL(bridge.url).port);
      const relay = await openTunnelRelay({ hostKey: host.privateKey, authorizedKey: client.publicKey, reversePort }); t.after(() => relay.close());
      const adapter = await openRelayAdapter({ reversePort, bridgePort, publicAuthority: `127.0.0.1:${publicPort}`, port: publicPort, connector: relay }); t.after(() => adapter.close());
      connector = await startConnector({ relayUrl: adapter.url.replace("http:", "ws:"), privateKey: client.privateKey, hostFingerprint: hostFingerprint(host.privateKey), reversePort, bridgePort }); t.after(() => connector?.close());
      machineUrl = adapter.url;
    }
    const grants = Object.fromEntries(["steady", "cancel", "revoke", "incomplete"].map(kind => [kind, leases.acquire(kind, `synthetic-${kind}`, new AbortController().signal)]));
    const abort = new AbortController(); t.after(() => abort.abort());
    const invoke = async (kind: "steady" | "cancel" | "revoke") => {
      const response = await fetch(`${machineUrl}/internal/session/tool-call`, {
        method: "POST", body: "{}",
        headers: { [ACCESS_HEADER]: grants[kind].token, authorization: "Bearer synthetic-native-key", "content-type": "application/json", "user-agent": kind },
        signal: kind === "cancel" ? abort.signal : AbortSignal.timeout(delayMs + 15_000),
      });
      return { status: response.status, body: await response.text() };
    };
    const begun = performance.now();
    const steady = invoke("steady");
    steady.catch(() => {});
    const cancel = invoke("cancel").then(result => result.status !== 200, () => true);
    const revoke = invoke("revoke").then(result => result.status !== 200, () => true);
    let incompleteRequest: ReturnType<typeof request>;
    const incomplete = new Promise<number>(resolve => {
      const began = performance.now();
      const finish = () => resolve(performance.now() - began);
      incompleteRequest = request(`${machineUrl}/internal/session/tool-call`, {
        method: "POST", headers: { [ACCESS_HEADER]: grants.incomplete.token, "content-type": "application/json", "content-length": "2", "user-agent": "incomplete" }, agent: false,
      }, response => { response.resume(); response.on("error", finish); response.on("end", finish); });
      incompleteRequest.on("error", finish); incompleteRequest.on("close", finish);
      incompleteRequest.write("{");
    });
    t.after(() => incompleteRequest?.destroy());
    await Promise.all(Object.values(started).map(value => value.promise));
    await sleep(15_600);
    abort.abort();
    leases.release(grants.revoke.key, grants.revoke.hostId, grants.revoke.id);
    assert.equal(await cancel, true, "Cancellation cannot return native success");
    assert.equal(await revoke, true, "Revocation cannot return native success");
    await bounded(Promise.all(Object.values(canceled).map(value => value.promise)));
    if (connector) assert.equal(connector.running(), true, "Independent grant revoke/cancel preserves the shared connector");
    const incompleteElapsed = await incomplete;
    assert.ok(incompleteElapsed >= 14_000 && incompleteElapsed < 20_000, `Incomplete body still bounded: ${Math.round(incompleteElapsed)}ms`);
    const result = await steady;
    const elapsed = performance.now() - begun;
    assert.deepEqual(result, { status: 200, body: "synthetic async native result" });
    assert.ok(elapsed >= delayMs, "Observed completion crosses the configured async response delay");
    assert.equal(nativeOperations, 3, "Incomplete body never reaches native dispatch");
    t.diagnostic(`${mode}: ordinary response ${Math.round(elapsed)}ms; incomplete body ${Math.round(incompleteElapsed)}ms; independent revoke/cancel passed`);
  })));
});
