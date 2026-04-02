import { fetch as undiciFetch } from "undici";

import type { LoggerPort } from "./ports";

export interface TranslationRequestOptions {
  model: string;
  baseUrl: string;
  apiKey: string;
  systemPrompt?: string;
  promptVersion: string;
  rulesVersion: string;
  requestTimeoutMs: number;
}

export interface TranslationClient {
  translateDocument(sourceMarkdown: string, options: TranslationRequestOptions, signal?: AbortSignal): Promise<string>;
}

interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
) => Promise<HttpResponseLike>;

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

export class OpenAiCompatibleClient implements TranslationClient {
  public constructor(
    private readonly logger: LoggerPort,
    private readonly fetcher: FetchLike = undiciFetch as FetchLike
  ) {}

  public async translateDocument(
    sourceMarkdown: string,
    options: TranslationRequestOptions,
    signal?: AbortSignal
  ): Promise<string> {
    this.logger.info("request: POST /chat/completions mode=full-document");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
    const abortHandler = (): void => controller.abort();
    signal?.addEventListener("abort", abortHandler);

    try {
      const response = await this.fetcher(`${options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: options.model,
          messages: [
            {
              role: "system",
              content: options.systemPrompt ?? ""
            },
            {
              role: "user",
              content: buildUserPrompt(sourceMarkdown)
            }
          ]
        }),
        signal: controller.signal
      });

      const rawBody = await response.text();
      let payload: ChatCompletionsResponse | undefined;
      if (rawBody.trim()) {
        try {
          payload = JSON.parse(rawBody) as ChatCompletionsResponse;
        } catch {
          payload = undefined;
        }
      }

      if (!response.ok) {
        const suffix = payload?.error?.message || truncateResponse(rawBody);
        throw new Error(`Translation request failed with status ${response.status}${suffix ? `: ${suffix}` : ""}`);
      }

      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content === "string") {
        return content;
      }

      if (Array.isArray(content)) {
        const text = content
          .filter((item) => item.type === "text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("")
          .trim();
        if (text) {
          return text;
        }
      }

      throw new Error("Translation response did not include message content");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortHandler);
    }
  }
}

function buildUserPrompt(sourceMarkdown: string): string {
  return [
    "Translate the full Markdown document to 简体中文 (Simplified Chinese).",
    "Return exactly one outer fenced Markdown block using 5 backticks.",
    "Do not return JSON.",
    "Do not explain anything.",
    "Source Markdown follows between the markers.",
    "<<<SOURCE_MARKDOWN>>>",
    sourceMarkdown,
    "<<<END_SOURCE_MARKDOWN>>>"
  ].join("\n");
}

function truncateResponse(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 200);
}
