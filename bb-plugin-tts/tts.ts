import { z } from "zod";

export const MAX_SPEECH_CHARACTERS = 4000;

export function extractSpeechText(markdown: string): string {
  const normalized = markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1. ")
    .replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, "$1. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*_]{3,}\s*$)/gm, "")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/(^|\s)\|/g, "$1 ")
    .replace(/\|(?=\s|$)/g, " ")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/gs, "$1$2")
    .replace(/\*(.+?)\*|_(.+?)_/gs, "$1$2")
    .replace(/~~(.+?)~~/gs, "$1")
    .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
    .replace(/\$([^\n$]+)\$/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\n+/g, ". ")
    .replace(/([.!?])\s*\.\s*/g, "$1 ")
    .replace(/(?:\.\s*){2,}/g, ". ")
    .replace(/[\t ]+/g, " ")
    .trim();
  return normalized.slice(0, MAX_SPEECH_CHARACTERS).trim();
}

export const speechRequestSchema = z
  .object({ text: z.string().trim().min(1).max(MAX_SPEECH_CHARACTERS) })
  .strict();

export const speechModelIds = ["openai/tts-1", "openai/tts-1-hd"] as const;

export const speechVoices = [
  "alloy",
  "echo",
  "fable",
  "nova",
  "onyx",
  "shimmer",
] as const;

const speechSettingsSchema = z
  .object({
    model: z.enum(speechModelIds),
    voice: z.enum(speechVoices),
    speed: z
      .number()
      .finite()
      .transform((speed) => Math.min(4, Math.max(0.25, speed))),
  })
  .strict();

export type SpeechSettings = z.input<typeof speechSettingsSchema>;

export function parseSpeechSettings(
  input: unknown,
): z.output<typeof speechSettingsSchema> {
  const parsed = speechSettingsSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Read aloud speech settings are invalid.");
  }
  return parsed.data;
}

export function buildGatewaySpeechBody(
  text: string,
  inputSettings: unknown,
): { model: (typeof speechModelIds)[number]; body: string } {
  const settings = parseSpeechSettings(inputSettings);
  return {
    model: settings.model,
    body: JSON.stringify({
      text,
      voice: settings.voice,
      speed: settings.speed,
      outputFormat: "mp3",
    }),
  };
}

export interface GatewaySpeechOptions {
  apiKey: string;
  text: string;
  signal: AbortSignal;
  settings: unknown;
  fetchImpl?: typeof fetch;
}

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const MAX_GATEWAY_RESPONSE_BYTES =
  Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 64 * 1024;

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("Gateway response exceeds the allowed size.");
  }
  if (response.body === null) {
    throw new Error("Vercel AI Gateway returned an empty response.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Gateway response exceeds the allowed size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function safeGatewayError(body: string, apiKey: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return undefined;
  }
  const error = "error" in payload ? payload.error : undefined;
  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error
        ? error.message
        : undefined;
  if (typeof message !== "string") return undefined;
  const safe = message
    .replaceAll(apiKey, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return safe || undefined;
}

function decodeAudio(payload: unknown): Uint8Array {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("audio" in payload) ||
    typeof payload.audio !== "string"
  ) {
    throw new Error("Vercel AI Gateway returned an invalid speech response.");
  }
  const encoded = payload.audio;
  if (encoded.length === 0 || encoded.length % 4 !== 0) {
    throw new Error("Vercel AI Gateway returned invalid base64 audio.");
  }
  const decodedLength =
    (encoded.length / 4) * 3 -
    (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  if (decodedLength > MAX_AUDIO_BYTES) {
    throw new Error("Generated audio exceeds the 10 MiB limit.");
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    throw new Error("Vercel AI Gateway returned invalid base64 audio.");
  }
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (
    (encoded.endsWith("==") &&
      (alphabet.indexOf(encoded.at(-3) ?? "") & 15) !== 0) ||
    (encoded.endsWith("=") &&
      !encoded.endsWith("==") &&
      (alphabet.indexOf(encoded.at(-2) ?? "") & 3) !== 0)
  ) {
    throw new Error("Vercel AI Gateway returned invalid base64 audio.");
  }
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    throw new Error("Vercel AI Gateway returned invalid base64 audio.");
  }
  if (decoded.length === 0) {
    throw new Error("Vercel AI Gateway returned empty audio.");
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export async function requestGatewaySpeech({
  apiKey,
  text,
  signal,
  settings,
  fetchImpl = fetch,
}: GatewaySpeechOptions): Promise<Uint8Array> {
  const parsed = speechRequestSchema.safeParse({ text });
  if (!parsed.success) {
    throw new Error("Speech text must contain 1–4000 characters.");
  }
  const gatewaySpeech = buildGatewaySpeechBody(parsed.data.text, settings);
  let response: Response;
  try {
    response = await fetchImpl(
      "https://ai-gateway.vercel.sh/v4/ai/speech-model",
      {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "ai-gateway-protocol-version": "0.0.1",
          "ai-speech-model-specification-version": "4",
          "ai-model-id": gatewaySpeech.model,
          "content-type": "application/json",
        },
        body: gatewaySpeech.body,
      },
    );
  } catch {
    throw new Error("Could not connect to Vercel AI Gateway.");
  }
  if (!response.ok) {
    let detail: string | undefined;
    try {
      const body = await readBoundedBody(response, MAX_ERROR_BODY_BYTES);
      detail = safeGatewayError(new TextDecoder().decode(body), apiKey);
    } catch {
      await response.body?.cancel();
    }
    throw new Error(
      `Vercel AI Gateway speech request failed (${response.status})${detail ? `: ${detail}` : "."}`,
    );
  }
  let body: Uint8Array;
  try {
    body = await readBoundedBody(response, MAX_GATEWAY_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof Error && error.message.includes("allowed size")) {
      throw new Error("Generated audio exceeds the 10 MiB limit.");
    }
    throw error;
  }
  if (body.byteLength === 0) {
    throw new Error("Vercel AI Gateway returned an empty speech response.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error("Vercel AI Gateway returned malformed speech JSON.");
  }
  return decodeAudio(payload);
}
