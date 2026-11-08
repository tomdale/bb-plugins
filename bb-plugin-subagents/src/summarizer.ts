import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractOneSentenceSummary } from "./status.ts";

export const SUMMARY_INTERVAL_MS = 30_000;
export const SUMMARY_EXCERPT_LIMIT = 2_000;

export interface SummarizeInput {
  title: string;
  task: string;
  status: string;
  error: string | null;
  excerpt: string;
}

export type StatusSummarizer = (input: SummarizeInput) => Promise<string>;

async function gatewayKey(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.VITEST) return null;
  const dir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  try {
    const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as {
      "vercel-ai-gateway"?: { type?: string; key?: unknown };
    };
    const stored = auth["vercel-ai-gateway"];
    if (stored?.type === "api_key" && typeof stored.key === "string") return stored.key;
  } catch {
    // Fall back to environment variable when Pi's auth file is absent.
  }
  return env.AI_GATEWAY_API_KEY?.trim() || null;
}

export function fallbackSummary(input: SummarizeInput): string {
  if (input.excerpt.trim()) return extractOneSentenceSummary(input.excerpt, input.title);
  if (input.error?.trim()) return extractOneSentenceSummary(input.error, input.title);
  if (input.status === "starting") {
    return extractOneSentenceSummary(input.task, `Starting worker thread for ${input.title}.`);
  }
  return extractOneSentenceSummary(input.task, `Working on ${input.title}.`);
}

export const defaultSummarizer: StatusSummarizer = async input => {
  const fallback = fallbackSummary(input);
  if (!input.excerpt.trim()) return fallback;
  const apiKey = await gatewayKey();
  if (!apiKey) return fallback;
  try {
    const response = await fetch("https://ai-gateway.vercel.sh/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        max_tokens: 80,
        system:
          "Write one plain-English sentence (at most 140 characters) summarizing the background subagent's current status from its latest output excerpt. Use no Markdown, no quotes, and no preamble.",
        messages: [
          {
            role: "user",
            content: `Subagent: ${input.title}\nStatus: ${input.status}\nLatest output excerpt:\n${input.excerpt.slice(-SUMMARY_EXCERPT_LIMIT)}`,
          },
        ],
      }),
    });
    if (!response.ok) return fallback;
    const body = (await response.json()) as { content?: { type?: string; text?: string }[] };
    const text = body.content?.find(part => part.type === "text")?.text?.trim();
    return text ? extractOneSentenceSummary(text, fallback) : fallback;
  } catch {
    return fallback;
  }
};
