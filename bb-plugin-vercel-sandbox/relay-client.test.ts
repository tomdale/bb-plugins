import { expect, it } from "vitest";
import { createVercelClient } from "./client.js";
import { vendorTransport } from "./vendor-test-transport.js";

it("pinned public vendor SDK emits a single bounded Node24 helper allocation, distinct from worker defaults — fake transport only", async () => {
  const vendor = vendorTransport();
  const credentials = { token: "synthetic-private-oidc", expiresAt: Date.now() + 3_600_000, teamId: "team_synthetic", projectId: "prj_synthetic" };
  let authenticated = false;
  const transport: typeof fetch = (input, init) => {
    authenticated = new Headers(init?.headers).get("authorization") === `Bearer ${credentials.token}`;
    return vendor.transport(input, init);
  };
  const client = createVercelClient(credentials, transport, async () => credentials);
  await client.createRelay(`bb-relay-${"a".repeat(48)}`, { bbProvider: "vercel-access-relay" }, "vercel/sandbox/node:24", new AbortController().signal);
  expect(authenticated).toBe(true);
  expect(vendor.requests).toHaveLength(1);
  expect(vendor.requests[0]!.url.searchParams.get("teamId")).toBe(credentials.teamId);
  expect(vendor.requests[0]!.body).toMatchObject({ projectId: credentials.projectId, image: "vercel/sandbox/node:24", resources: { vcpus: 1 }, timeout: 600_000, ports: [8080], persistent: false });
  expect(JSON.stringify(vendor.requests)).not.toContain(credentials.token);
});
