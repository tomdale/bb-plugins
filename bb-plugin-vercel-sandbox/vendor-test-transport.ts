import { z } from "zod";

const bodySchema = z.record(z.string(), z.unknown());
const createSchema = z.object({
  name: z.string(),
  persistent: z.literal(false),
  image: z.literal("vercel/sandbox/universal:latest"),
  resources: z.object({ vcpus: z.number() }),
  timeout: z.number(),
  projectId: z.string(),
  tags: z.record(z.string(), z.string()),
});
export function vendorTransport() {
  const requests: {
    url: URL;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  const allocations = new Map<string, ReturnType<typeof responseFor>>();
  const sessions = new Map<string, ReturnType<typeof responseFor>["session"]>();
  const hiddenSessions = new Set<string>();
  let allocationCount = 0;
  let deleteCount = 0;
  let failure:
    | "network-after"
    | "network-before"
    | "abort-after"
    | number
    | null = null;
  let readFailures = 0;
  let deleteFailure = false;
  let deleteBeforeFailure = false;
  let stopFailure: "network-after" | "network-before" | number | null = null;
  let stopStatus = "stopped";
  let listFailure = false;
  let onCreate: (() => Promise<void>) | null = null;
  let onStop: (() => Promise<void>) | null = null;
  let onDelete: (() => Promise<void>) | null = null;
  let onGet: (() => Promise<void>) | null = null;
  let acceptOnClientError = false;
  let sessionScopeMismatch = false;
  function responseFor(input: z.infer<typeof createSchema>) {
    const session = {
      id: `session-${++allocationCount}`,
      memory: input.resources.vcpus * 2048,
      vcpus: input.resources.vcpus,
      region: "iad1",
      timeout: input.timeout,
      status: "running",
      requestedAt: 100,
      startedAt: 200,
      createdAt: 100,
      cwd: "/vercel",
      updatedAt: 200,
      projectId: input.projectId,
      sourceSandboxName: input.name,
    };
    return {
      sandbox: {
        name: input.name,
        persistent: false,
        image: input.image,
        vcpus: session.vcpus,
        memory: session.memory,
        timeout: input.timeout,
        createdAt: 100,
        updatedAt: 200,
        currentSessionId: session.id,
        status: session.status,
        tags: input.tags,
      },
      session,
      routes: [],
    };
  }
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const error = (status: number) =>
    json(
      {
        error: {
          code: status === 404 ? "not_found" : "vendor_error",
          message: "vendor echoes secret-token",
        },
      },
      status,
    );
  const transport: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? bodySchema.parse(JSON.parse(init.body))
        : {};
    requests.push({ url, method, body });
    if (method === "GET" && readFailures > 0) {
      readFailures--;
      return error(503);
    }
    if (method === "POST" && url.pathname === "/api/v3/sandboxes") {
      await onCreate?.();
      const create = createSchema.parse(body);
      if (typeof failure === "number" && failure < 500 && !acceptOnClientError)
        return error(failure);
      if (failure === "network-before")
        throw new Error("secret-token network error");
      if (allocations.has(create.name)) return error(400);
      const response = responseFor(create);
      allocations.set(create.name, response);
      sessions.set(response.session.id, response.session);
      if (failure === "network-after")
        throw new Error("secret-token connection lost after allocation");
      if (failure === "abort-after")
        throw new DOMException("secret-token response aborted", "AbortError");
      if (typeof failure === "number") return error(failure);
      return json(response);
    }
    if (url.pathname.startsWith("/api/v2/sandboxes/sessions/")) {
      const id = url.pathname.split("/")[5]!;
      const session = sessions.get(id);
      if (!session || hiddenSessions.has(id)) return error(404);
      if (method === "GET")
        return json({
          session: sessionScopeMismatch
            ? { ...session, projectId: "prj_foreign" }
            : session,
          routes: [],
        });
      if (method === "POST" && url.pathname.endsWith("/stop")) {
        await onStop?.();
        if (stopFailure === "network-before")
          throw new Error("secret-token network error");
        session.status = stopStatus;
        const allocation = allocations.get(session.sourceSandboxName);
        if (allocation) allocation.sandbox.status = stopStatus;
        if (stopFailure === "network-after")
          throw new Error("secret-token lost stop response");
        if (typeof stopFailure === "number") return error(stopFailure);
        return json({
          session,
          ...(allocation ? { sandbox: allocation.sandbox } : {}),
        });
      }
    }
    if (url.pathname === "/api/v2/sandboxes" && method === "GET") {
      return listFailure
        ? error(403)
        : json({
            sandboxes: [...allocations.values()].map((entry) => entry.sandbox),
            pagination: { count: allocations.size, next: null },
          });
    }
    if (
      url.pathname.startsWith("/api/v2/sandboxes/") &&
      !url.pathname.includes("/sessions/")
    ) {
      const name = decodeURIComponent(
        url.pathname.slice("/api/v2/sandboxes/".length),
      );
      const allocation = allocations.get(name);
      if (method === "GET") {
        await onGet?.();
        return allocation ? json(allocation) : error(404);
      }
      if (method === "DELETE") {
        await onDelete?.();
        if (!allocation) return error(404);
        if (deleteBeforeFailure) return error(503);
        allocations.delete(name);
        hiddenSessions.add(allocation.session.id);
        deleteCount++;
        return deleteFailure ? error(503) : json({});
      }
    }
    throw new Error(
      `Unhandled mocked vendor request ${method} ${url.pathname}`,
    );
  };
  return {
    transport,
    requests,
    allocations,
    sessions,
    hiddenSessions,
    get allocationCount() {
      return allocationCount;
    },
    get deleteCount() {
      return deleteCount;
    },
    set failure(value: typeof failure) {
      failure = value;
    },
    set readFailures(value: number) {
      readFailures = value;
    },
    set deleteFailure(value: boolean) {
      deleteFailure = value;
    },
    set deleteBeforeFailure(value: boolean) {
      deleteBeforeFailure = value;
    },
    set stopFailure(value: typeof stopFailure) {
      stopFailure = value;
    },
    set stopStatus(value: string) {
      stopStatus = value;
    },
    set listFailure(value: boolean) {
      listFailure = value;
    },
    set onCreate(value: typeof onCreate) {
      onCreate = value;
    },
    set onStop(value: typeof onStop) {
      onStop = value;
    },
    set onDelete(value: typeof onDelete) {
      onDelete = value;
    },
    set onGet(value: typeof onGet) {
      onGet = value;
    },
    set acceptOnClientError(value: boolean) {
      acceptOnClientError = value;
    },
    set sessionScopeMismatch(value: boolean) {
      sessionScopeMismatch = value;
    },
  };
}
