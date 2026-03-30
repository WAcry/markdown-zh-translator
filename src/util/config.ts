import type { ConfigurationPort } from "../services/ports";

export interface ExtensionSettings {
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
  systemPrompt?: string;
  localBlobCacheMaxBytes: number;
  deleteTranslatedOnClose: boolean;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_LOCAL_BLOB_CACHE_MAX_BYTES = 10 * 1024 * 1024;

export function readExtensionSettings(config: ConfigurationPort): ExtensionSettings {
  const rawBaseUrl = (config.get<string>("baseUrl") ?? DEFAULT_BASE_URL).trim();
  const model = (config.get<string>("model") ?? "").trim();
  const requestTimeoutMs = Number(config.get<number>("requestTimeoutMs") ?? DEFAULT_TIMEOUT_MS);
  const systemPrompt = (config.get<string>("systemPrompt") ?? "").trim();
  const localBlobCacheMaxBytes = Number(config.get<number>("localBlobCacheMaxBytes") ?? DEFAULT_LOCAL_BLOB_CACHE_MAX_BYTES);
  const deleteTranslatedOnClose = Boolean(config.get<boolean>("deleteTranslatedOnClose") ?? false);

  if (!model) {
    throw new Error("Missing required setting: markdownTranslator.model");
  }

  let baseUrl: string;
  try {
    const parsed = new URL(rawBaseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Unsupported protocol");
    }
    baseUrl = parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("Invalid setting: markdownTranslator.baseUrl must be an absolute HTTP(S) URL");
  }

  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1000) {
    throw new Error("Invalid setting: markdownTranslator.requestTimeoutMs must be at least 1000");
  }

  if (!Number.isFinite(localBlobCacheMaxBytes) || localBlobCacheMaxBytes < 0) {
    throw new Error("Invalid setting: markdownTranslator.localBlobCacheMaxBytes must be zero or greater");
  }

  return {
    baseUrl,
    model,
    requestTimeoutMs,
    systemPrompt: systemPrompt || undefined,
    localBlobCacheMaxBytes,
    deleteTranslatedOnClose
  };
}

export function readDeleteTranslatedOnCloseSetting(config: ConfigurationPort): boolean {
  return Boolean(config.get<boolean>("deleteTranslatedOnClose") ?? false);
}
