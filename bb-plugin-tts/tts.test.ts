import { describe, expect, it, vi } from "vitest";
import {
  buildGatewaySpeechBody,
  extractSpeechText,
  MAX_SPEECH_CHARACTERS,
  parseSpeechSettings,
  requestGatewaySpeech,
} from "./tts.js";
import { handleSpeechRequest, default as plugin } from "./server.js";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

describe("extractSpeechText", () => {
  it("reads prose while removing common Markdown presentation", () => {
    expect(
      extractSpeechText(
        "# **Answer**\n\nA [useful link](https://example.com) and `inline code`.\n\n- First\n- _Second_\n\n> Quoted text",
      ),
    ).toBe("Answer. A useful link and inline code. First. Second. Quoted text");
  });

  it("retains code block text, removes HTML tags, and caps the output", () => {
    expect(
      extractSpeechText(
        "Before\n\n```ts\nconst answer = 42;\n```\n\n<strong>After</strong>",
      ),
    ).toBe("Before. const answer = 42;. After");
    expect(
      extractSpeechText("x".repeat(MAX_SPEECH_CHARACTERS + 5)),
    ).toHaveLength(MAX_SPEECH_CHARACTERS);
  });
});

describe("Gateway speech settings", () => {
  it("uses current defaults and constructs MP3 requests from validated settings", () => {
    expect(
      buildGatewaySpeechBody("Hello", {
        model: "openai/tts-1",
        voice: "alloy",
        speed: 1,
      }),
    ).toEqual({
      model: "openai/tts-1",
      body: JSON.stringify({
        text: "Hello",
        voice: "alloy",
        speed: 1,
        outputFormat: "mp3",
      }),
    });
    expect(
      buildGatewaySpeechBody("Hello", {
        model: "openai/tts-1-hd",
        voice: "nova",
        speed: 1.5,
      }),
    ).toEqual({
      model: "openai/tts-1-hd",
      body: JSON.stringify({
        text: "Hello",
        voice: "nova",
        speed: 1.5,
        outputFormat: "mp3",
      }),
    });
  });

  it("clamps finite speeds and rejects invalid models, voices, and non-finite values", () => {
    expect(
      parseSpeechSettings({
        model: "openai/tts-1",
        voice: "alloy",
        speed: 0.1,
      }).speed,
    ).toBe(0.25);
    expect(
      parseSpeechSettings({
        model: "openai/tts-1",
        voice: "alloy",
        speed: 9,
      }).speed,
    ).toBe(4);
    for (const invalid of [
      { model: "unknown/model", voice: "alloy", speed: 1 },
      { model: "openai/tts-1", voice: "unknown", speed: 1 },
      { model: "openai/tts-1", voice: "alloy", speed: Number.NaN },
      {
        model: "openai/tts-1",
        voice: "alloy",
        speed: Number.POSITIVE_INFINITY,
      },
      { model: "openai/tts-1", voice: "alloy", speed: 1, extra: true },
    ]) {
      expect(() => parseSpeechSettings(invalid)).toThrow(
        "Read aloud speech settings are invalid.",
      );
    }
  });
});

describe("Gateway speech boundary", () => {
  it("resolves the untrusted thread id server-side and never returns the key", async () => {
    const host = createFakePluginHost({ pluginId: "tts" });
    host.harness.sdk.stub("threads.get", async ({ threadId }) => {
      if (threadId !== "thread-valid") throw new Error("Thread not found");
      return {};
    });
    Object.defineProperty(host.bb, "experimental_resolveAiGatewayApiKey", {
      value: async ({
        scope,
        threadId,
      }: {
        scope: string;
        threadId?: string;
      }) => {
        if (scope === "global") return undefined;
        if (threadId !== "thread-valid") throw new Error("Thread not found");
        return "server-environment-key";
      },
    });
    await plugin(host.bb);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ audio: "AQI=", warnings: [] }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const response = await host.harness.fetchHttp("POST", "/speech", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-valid", text: "hello" }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.text()).not.toContain("server-environment-key");
    expect(
      new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer server-environment-key");
    expect(
      new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("ai-model-id"),
    ).toBe("openai/tts-1");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      text: "hello",
      voice: "alloy",
      speed: 1,
      outputFormat: "mp3",
    });

    const unknownThread = await host.harness.fetchHttp("POST", "/speech", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-unknown", text: "hello" }),
    });
    expect(unknownThread.status).toBe(404);
    expect(await unknownThread.text()).not.toContain("server-environment-key");
    await host.harness.lifecycle.dispose();
  });
  it("applies saved speech settings to requests without exposing them to the client", async () => {
    const host = createFakePluginHost({
      pluginId: "tts",
      settings: {
        apiKey: "plugin-override",
        model: "openai/tts-1-hd",
        voice: "nova",
        speed: 1.5,
      },
    });
    host.harness.sdk.stub("threads.get", async () => ({}));
    await plugin(host.bb);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ audio: "AQI=", warnings: [] }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const response = await host.harness.fetchHttp("POST", "/speech", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-valid", text: "hello" }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("plugin-override");
    expect(
      new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("ai-model-id"),
    ).toBe("openai/tts-1-hd");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      text: "hello",
      voice: "nova",
      speed: 1.5,
      outputFormat: "mp3",
    });
    await host.harness.lifecycle.dispose();
  });

  it("validates the thread even when a plugin override is configured", async () => {
    const host = createFakePluginHost({
      pluginId: "tts",
      settings: { apiKey: "plugin-override" },
    });
    host.harness.sdk.stub("threads.get", async () => {
      throw new Error("Thread not found");
    });
    const resolveKey = vi.fn(async ({ scope }: { scope: string }) =>
      scope === "global" ? undefined : "unused-thread-key",
    );
    Object.defineProperty(host.bb, "experimental_resolveAiGatewayApiKey", {
      value: resolveKey,
    });
    await plugin(host.bb);
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);
    const response = await host.harness.fetchHttp("POST", "/speech", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-missing", text: "hello" }),
    });
    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolveKey.mock.calls).toEqual([[{ scope: "global" }]]);
    await host.harness.lifecycle.dispose();
  });

  it("validates the thread on older plugin SDK runtimes that lack the scoped accessor", async () => {
    const host = createFakePluginHost({
      pluginId: "tts",
      settings: { apiKey: "plugin-override" },
    });
    host.harness.sdk.stub("threads.get", async ({ threadId }) => {
      if (threadId === "thread-missing") throw new Error("Thread not found");
      return {};
    });
    Object.defineProperty(host.bb, "experimental_resolveAiGatewayApiKey", {
      value: undefined,
    });
    await plugin(host.bb);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ audio: "AQ==", warnings: [] }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const missing = await host.harness.fetchHttp("POST", "/speech", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-missing", text: "hello" }),
    });
    expect(missing.status).toBe(404);
    const existing = await host.harness.fetchHttp("POST", "/speech", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-existing", text: "hello" }),
    });
    expect(existing.status).toBe(200);
    await host.harness.lifecycle.dispose();
  });

  it("uses configured models, voices, and speed in the Gateway request", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ audio: "AQI=", warnings: [] }),
    );
    await requestGatewaySpeech({
      apiKey: "server-only-secret",
      text: "Hello",
      signal: new AbortController().signal,
      settings: {
        model: "openai/tts-1-hd",
        voice: "nova",
        speed: 1.75,
      },
      fetchImpl,
    });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("ai-model-id")).toBe(
      "openai/tts-1-hd",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "Hello",
      voice: "nova",
      speed: 1.75,
      outputFormat: "mp3",
    });
  });

  it("rejects unsupported voice/model combinations before calling Gateway", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      requestGatewaySpeech({
        apiKey: "k",
        text: "Hello",
        signal: new AbortController().signal,
        settings: {
          model: "openai/tts-1",
          voice: "unknown",
          speed: 1,
        },
        fetchImpl,
      }),
    ).rejects.toThrow("Read aloud speech settings are invalid.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("builds requests with configured voice and model and retains MP3 output", () => {
    expect(
      buildGatewaySpeechBody("Hello", {
        model: "openai/tts-1",
        voice: "alloy",
        speed: 1,
      }),
    ).toEqual({
      model: "openai/tts-1",
      body: JSON.stringify({
        text: "Hello",
        voice: "alloy",
        speed: 1,
        outputFormat: "mp3",
      }),
    });
  });

  it("rejects settings values outside the supported model and voice lists", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      requestGatewaySpeech({
        apiKey: "k",
        text: "Hello",
        signal: new AbortController().signal,
        settings: {
          model: "openai/tts-1",
          voice: "Kore",
          speed: 1,
        },
        fetchImpl,
      }),
    ).rejects.toThrow("Read aloud speech settings are invalid.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the bounded text to the documented speech endpoint with server credentials", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ audio: "AQI=", warnings: [] }),
    );
    const signal = new AbortController().signal;
    const response = await requestGatewaySpeech({
      apiKey: "server-only-secret",
      text: "Hello",
      signal,
      settings: { model: "openai/tts-1", voice: "alloy", speed: 1 },
      fetchImpl,
    });
    expect(response).toEqual(new Uint8Array([1, 2]));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ai-gateway.vercel.sh/v4/ai/speech-model",
      expect.objectContaining({
        signal,
        headers: {
          authorization: "Bearer server-only-secret",
          "ai-gateway-protocol-version": "0.0.1",
          "ai-speech-model-specification-version": "4",
          "ai-model-id": "openai/tts-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "Hello",
          voice: "alloy",
          speed: 1,
          outputFormat: "mp3",
        }),
      }),
    );
  });

  it("rejects invalid text, malformed speech payloads, and oversized audio", async () => {
    const options = {
      apiKey: "k",
      text: "Hello",
      signal: new AbortController().signal,
      settings: { model: "openai/tts-1", voice: "alloy", speed: 1 },
    };
    await expect(
      requestGatewaySpeech({ ...options, text: " " }),
    ).rejects.toThrow("1–4000");
    await expect(
      requestGatewaySpeech({
        ...options,
        fetchImpl: async () => new Response("not JSON"),
      }),
    ).rejects.toThrow("malformed speech JSON");
    await expect(
      requestGatewaySpeech({
        ...options,
        fetchImpl: async () => Response.json({ audio: "%%%", warnings: [] }),
      }),
    ).rejects.toThrow("invalid base64 audio");
    await expect(
      requestGatewaySpeech({
        ...options,
        fetchImpl: async () => Response.json({ audio: "" }),
      }),
    ).rejects.toThrow("invalid base64 audio");
    await expect(
      requestGatewaySpeech({
        ...options,
        fetchImpl: async () => Response.json({ audio: "A".repeat(14_000_000) }),
      }),
    ).rejects.toThrow("10 MiB limit");
  });

  it("surfaces bounded Gateway errors without credentials", async () => {
    await expect(
      requestGatewaySpeech({
        apiKey: "private-key",
        text: "Hello",
        signal: new AbortController().signal,
        settings: { model: "openai/tts-1", voice: "alloy", speed: 1 },
        fetchImpl: async () =>
          Response.json(
            { error: { message: "Rejected private-key\nplease retry" } },
            { status: 401 },
          ),
      }),
    ).rejects.toThrow(
      "Vercel AI Gateway speech request failed (401): Rejected [redacted] please retry",
    );
  });

  it("validates incoming data, requires configuration, and returns non-cacheable audio", async () => {
    const absentKey = await handleSpeechRequest(
      new Request("http://localhost/speech", { method: "POST", body: "{}" }),
      undefined,
      { model: "openai/tts-1", voice: "alloy", speed: 1 },
    );
    expect(absentKey.status).toBe(503);

    const invalid = await handleSpeechRequest(
      new Request("http://localhost/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "thread_1",
          text: "ok",
          extra: "ignored?",
        }),
      }),
      "secret",
      { model: "openai/tts-1", voice: "alloy", speed: 1 },
    );
    expect(invalid.status).toBe(400);

    const audio = new Uint8Array([3, 4, 5]);
    const response = await handleSpeechRequest(
      new Request("http://localhost/speech", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
      "server-only-secret",
      { model: "openai/tts-1", voice: "alloy", speed: 1 },
      async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer server-only-secret",
        );
        return Response.json({ audio: "AwQF", warnings: [] });
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio);
  });
});
