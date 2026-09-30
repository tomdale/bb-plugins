import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  speechRequestSchema,
  requestGatewaySpeech,
  speechModelIds,
  speechVoices,
} from "./tts.js";

export async function handleSpeechRequest(
  request: Request,
  apiKey: string | undefined,
  settings: { model: string; voice: string; speed: number },
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!apiKey) {
    return Response.json(
      {
        error:
          "Set AI_GATEWAY_API_KEY in BB Environment variables or configure the plugin key override.",
      },
      { status: 503 },
    );
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 16 * 1024) {
    return Response.json(
      { error: "Request body is too large." },
      { status: 413 },
    );
  }
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return Response.json(
      { error: "Request body could not be read." },
      { status: 400 },
    );
  }
  if (new TextEncoder().encode(rawBody).byteLength > 16 * 1024) {
    return Response.json(
      { error: "Request body is too large." },
      { status: 413 },
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(rawBody);
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }
  const parsed = speechRequestSchema.safeParse(input);
  if (!parsed.success) {
    return Response.json(
      { error: "Text must contain 1–4000 characters." },
      { status: 400 },
    );
  }
  try {
    const gatewayResponse = await requestGatewaySpeech({
      apiKey,
      text: parsed.data.text,
      signal: request.signal,
      settings,
      fetchImpl,
    });
    const audio = gatewayResponse;
    const audioBuffer = new ArrayBuffer(audio.byteLength);
    new Uint8Array(audioBuffer).set(audio);
    return new Response(audioBuffer, {
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (request.signal.aborted) {
      return Response.json(
        { error: "Speech request was cancelled." },
        { status: 499 },
      );
    }
    const message =
      error instanceof Error ? error.message : "Speech generation failed.";
    const safeMessage = message
      .replaceAll(apiKey, "[redacted]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    return Response.json(
      { error: safeMessage || "Speech generation failed." },
      { status: 502 },
    );
  }
}

type AiGatewayKeyScope =
  | { scope: "global" }
  | { scope: "thread"; threadId: string };

function environmentKeyResolver(
  bb: BbPluginApi,
): ((scope: AiGatewayKeyScope) => Promise<string | undefined>) | null {
  if (!("experimental_resolveAiGatewayApiKey" in bb)) return null;
  const resolve = bb.experimental_resolveAiGatewayApiKey;
  if (typeof resolve !== "function") return null;
  return async (scope) => {
    const value: unknown = await resolve.call(bb, scope);
    return typeof value === "string" ? value : undefined;
  };
}

export default async function plugin(bb: BbPluginApi) {
  const resolveEnvironmentKey = environmentKeyResolver(bb);
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "Vercel AI Gateway API key override",
      description:
        "Optional server-side override. Otherwise Read aloud uses AI_GATEWAY_API_KEY from BB Environment variables for this thread's project, then the global value.",
      secret: true,
    },
    model: {
      type: "select",
      label: "Speech model",
      options: [...speechModelIds],
      default: "openai/tts-1",
    },
    voice: {
      type: "select",
      label: "Voice",
      options: [...speechVoices],
      default: "alloy",
    },
    speed: {
      type: "number",
      label: "Speaking speed",
      description: "Supported range is 0.25–4; values outside it are clamped.",
      experimental_schema: z.number().finite(),
      default: 1,
    },
  });
  bb.http.route("POST", "/speech", async (context) => {
    const contentLength = Number(context.req.header("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 16 * 1024) {
      return Response.json(
        { error: "Request body is too large." },
        { status: 413 },
      );
    }
    let rawBody: string;
    try {
      rawBody = await context.req.text();
    } catch {
      return Response.json(
        { error: "Request body could not be read." },
        { status: 400 },
      );
    }
    if (new TextEncoder().encode(rawBody).byteLength > 16 * 1024) {
      return Response.json(
        { error: "Request body is too large." },
        { status: 413 },
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON." },
        { status: 400 },
      );
    }
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      !("threadId" in body) ||
      typeof body.threadId !== "string" ||
      body.threadId.length === 0 ||
      !("text" in body) ||
      typeof body.text !== "string" ||
      Object.keys(body).some((key) => key !== "threadId" && key !== "text")
    ) {
      return Response.json(
        { error: "Request must include threadId and text." },
        { status: 400 },
      );
    }
    let environmentKey: string | undefined;
    try {
      await bb.sdk.threads.get({ threadId: body.threadId });
      environmentKey = await resolveEnvironmentKey?.({
        scope: "thread",
        threadId: body.threadId,
      });
    } catch {
      return Response.json({ error: "Thread not found." }, { status: 404 });
    }
    const configuredSettings = await settings.get();
    const apiKey = configuredSettings.apiKey?.trim() || environmentKey?.trim();
    const request = new Request(context.req.url, {
      body: JSON.stringify({ text: body.text }),
      headers: context.req.raw.headers,
      method: context.req.raw.method,
      signal: context.req.raw.signal,
    });
    return handleSpeechRequest(request, apiKey || undefined, {
      model: configuredSettings.model,
      voice: configuredSettings.voice,
      speed: configuredSettings.speed,
    });
  });
  const { apiKey } = await settings.get();
  const globalEnvironmentKey = await resolveEnvironmentKey?.({
    scope: "global",
  });
  if (!(apiKey?.trim() || globalEnvironmentKey?.trim())) {
    bb.status.needsConfiguration(
      resolveEnvironmentKey
        ? "Set AI_GATEWAY_API_KEY in Settings → Environment variables (global) or configure the plugin key. Project overrides apply only to their own threads."
        : "Configure the plugin key override, or upgrade BB to use AI_GATEWAY_API_KEY from Environment variables.",
    );
  }
}
