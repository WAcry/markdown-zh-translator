import { sha256Hex } from "./hash";

export const TARGET_LOCALE = "zh-CN";
export const PROVIDER_ID = "openai-compatible";
export const PROMPT_VERSION = "v1";
export const RULES_VERSION = "v1";

export const BUILTIN_SYSTEM_PROMPT = [
  "You translate the full Markdown document from English to 简体中文 (Simplified Chinese).",
  "Return exactly one outer fenced Markdown block using 5 backticks.",
  "The first line must be `````markdown and the last line must be `````.",
  "Do not return JSON.",
  "Do not add explanations before or after the fenced block.",
  "Preserve fenced code blocks exactly.",
  "Preserve inline code exactly.",
  "Preserve link destinations and image destinations exactly.",
  "Preserve file paths exactly.",
  "Preserve HTML tag names exactly.",
  "Preserve math expressions exactly.",
  "If the document starts with YAML frontmatter, you may translate the value for any key.",
  "Do not translate YAML keys.",
  "Preserve YAML structure, indentation, separators, and key names exactly."
].join("\n");

export function normalizeSystemPrompt(systemPrompt?: string): string {
  return (systemPrompt ?? "").trim();
}

export function computeConfigSignature(input: {
  baseUrl: string;
  model: string;
  systemPrompt?: string;
}): string {
  const normalizedPrompt = normalizeSystemPrompt(input.systemPrompt);
  return sha256Hex(
    [
      TARGET_LOCALE,
      PROVIDER_ID,
      input.baseUrl,
      input.model.trim(),
      PROMPT_VERSION,
      RULES_VERSION,
      sha256Hex(normalizedPrompt)
    ].join("\n")
  );
}
