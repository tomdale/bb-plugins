import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { PROBE_PATH, ProbeVerifier, assertSafeHeaders, digest, signProbe } from "./authorization.ts";
import { acquireIntent, activate, beginRelease, type GrantRecord } from "./grants.ts";

function headersOf(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
  }
  return headers;
}

async function localGet(url: string, options: { headers: Record<string, string> }): Promise<Response> {
  assert.equal(new URL(url).hostname, "127.0.0.1");
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: options.headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode })));
    });
    request.on("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("Local test timeout")));
    request.end();
  });
}

async function listen(handler: (request: IncomingMessage) => Promise<Response>) {
  const server = createServer(async (request, response) => {
    try {
      const result = await handler(request);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(401).end("refused");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test("local HTTP authorization chain rejects bypass, scoped misuse, and revocation", async (t) => {
  const keys = generateKeyPairSync("ed25519");
  const identity = { installationId: "installation_test", relayId: "relay_test", generation: 1 };
  let grant: GrantRecord = activate(acquireIntent(undefined, {
    key: "launch_test", id: "grant_test", hostId: "host_test", expiresAt: Date.now() + 60_000,
  }));
  const machineToken = randomUUID();
  const credentialDigests = new Map([[digest(machineToken), { grantId: grant.id, scope: "transport:probe" }]]);
  let fixtureHits = 0;
  const fixtureVerifier = new ProbeVerifier(keys.publicKey, identity);
  const relayVerifier = new ProbeVerifier(keys.publicKey, identity);
  const verifyRequest = (request: IncomingMessage, verifier: ProbeVerifier) => {
    const headers = headersOf(request);
    if (headers.has("transfer-encoding") || (headers.has("content-length") && headers.get("content-length") !== "0")) {
      throw new Error("Probe must not carry a body");
    }
    return verifier.verify({
      assertion: headers.get("x-va-assertion") ?? "", method: request.method ?? "",
      target: request.url ?? "", bodyHash: digest(""), headers, grant, now: Date.now(),
    });
  };
  const fixture = await listen(async (request) => {
    verifyRequest(request, fixtureVerifier);
    fixtureHits++;
    return Response.json({ status: "synthetic-probe-only" });
  });
  t.after(() => fixture.close());
  const relay = await listen(async (request) => {
    verifyRequest(request, relayVerifier);
    return localGet(`${fixture.url}${PROBE_PATH}`, {
      headers: { "x-va-assertion": headersOf(request).get("x-va-assertion")! },
    });
  });
  t.after(() => relay.close());
  const gateway = await listen(async (request) => {
    const headers = headersOf(request);
    assertSafeHeaders(headers);
    const credential = credentialDigests.get(digest(headers.get("x-va-token") ?? ""));
    if (!credential || credential.scope !== "transport:probe" || credential.grantId !== grant.id ||
        request.method !== "GET" || request.url !== PROBE_PATH || headers.has("x-va-assertion") ||
        headers.has("transfer-encoding") || (headers.has("content-length") && headers.get("content-length") !== "0")) {
      return new Response("refused", { status: 401 });
    }
    const now = Date.now();
    const assertion = signProbe({
      ...identity, version: 0, grantId: grant.id, hostId: grant.hostId,
      scope: "transport:probe", method: "GET", target: PROBE_PATH, bodyHash: digest(""),
      issuedAt: now, expiresAt: now + 15_000, nonce: randomUUID(),
    }, keys.privateKey);
    return localGet(`${relay.url}${PROBE_PATH}`, { headers: { "x-va-assertion": assertion } });
  });
  t.after(() => gateway.close());
  const get = (url: string, headers: Record<string, string> = {}) => localGet(`${url}${PROBE_PATH}`, { headers });

  assert.equal((await get(gateway.url)).status, 401);
  assert.equal((await get(gateway.url, { "x-va-token": "incorrect" })).status, 401);
  assert.equal((await get(relay.url, { "x-va-token": machineToken })).status, 401);
  assert.equal((await get(fixture.url, { "x-va-token": machineToken })).status, 401);
  for (const name of ["x-bb-gate-auth", "x-bb-gate-machine-id", "x-forwarded-host"]) {
    assert.equal((await get(gateway.url, { "x-va-token": machineToken, [name]: "synthetic" })).status, 401);
    assert.equal((await get(relay.url, { [name]: "synthetic" })).status, 401);
  }
  credentialDigests.set(digest("wrong-scope-synthetic"), { grantId: grant.id, scope: "owner" });
  assert.equal((await get(gateway.url, { "x-va-token": "wrong-scope-synthetic" })).status, 401);
  for (const path of ["/api/v1/hosts", "/internal/hosts/enroll-key", "/internal/hosts/enroll", "/internal/ws"]) {
    assert.equal((await localGet(`${gateway.url}${path}`, { headers: { "x-va-token": machineToken } })).status, 401);
  }
  assert.equal(fixtureHits, 0);
  const result = await get(gateway.url, { "x-va-token": machineToken });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { status: "synthetic-probe-only" });
  assert.equal(fixtureHits, 1);
  grant = beginRelease(grant, { key: grant.key, hostId: grant.hostId, grantId: null });
  assert.equal((await get(gateway.url, { "x-va-token": machineToken })).status, 401);
  assert.equal(fixtureHits, 1);
});
