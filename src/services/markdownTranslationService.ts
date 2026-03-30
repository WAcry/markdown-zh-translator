import { dirname, join } from "node:path";

import type { ApiKeyStore } from "./apiKeyStore";
import type { CacheRecord } from "./cacheStore";
import type { CacheStore } from "./cacheStore";
import type { MarkdownIntegrityValidator } from "./markdownIntegrityValidator";
import type { MarkdownResponseParser } from "./markdownResponseParser";
import type { TranslationClient } from "./openAiCompatibleClient";
import type { ConfigurationPort, DocumentStatePort, FileSystemPort, LoggerPort, SourceDocumentSnapshot } from "./ports";
import { sha256Hex } from "../util/hash";
import { computeConfigSignature, PROVIDER_ID, PROMPT_VERSION, RULES_VERSION, TARGET_LOCALE, BUILTIN_SYSTEM_PROMPT, normalizeSystemPrompt } from "../util/translationContract";
import { readExtensionSettings } from "../util/config";

export interface TranslationRunResult {
  targetUri: string;
  cacheStatus: "hit" | "miss";
}

interface MarkdownTranslationServiceDeps {
  config: ConfigurationPort;
  apiKeyStore: ApiKeyStore;
  cacheStore: CacheStore;
  translationClient: TranslationClient;
  responseParser: MarkdownResponseParser;
  integrityValidator: MarkdownIntegrityValidator;
  fileSystem: FileSystemPort;
  documentState: DocumentStatePort;
  logger: LoggerPort;
  now?: () => string;
}

export class MarkdownTranslationService {
  private readonly now: () => string;

  public constructor(private readonly deps: MarkdownTranslationServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  public async translateCurrentDocument(
    document: SourceDocumentSnapshot,
    options?: { signal?: AbortSignal }
  ): Promise<TranslationRunResult> {
    validateDocument(document);

    const settings = readExtensionSettings(this.deps.config);
    const apiKey = (await this.deps.apiKeyStore.getApiKey())?.trim();
    if (!apiKey) {
      throw new Error("Missing API key. Run 'Markdown Translator: Set API Key' first.");
    }

    const targetUri = toTargetMarkdownPath(document.fileName);
    if (this.deps.documentState.isDirty(targetUri)) {
      this.deps.logger.warn("target is dirty, abort overwrite");
      throw new Error("Please save or discard unsaved changes in the translated Markdown file before translating again.");
    }

    const sourceHash = sha256Hex(document.text);
    const configSignature = computeConfigSignature({
      baseUrl: settings.baseUrl,
      model: settings.model,
      systemPrompt: settings.systemPrompt
    });

    const cacheRecord = await this.deps.cacheStore.get(document.uri);
    const targetExists = await this.deps.fileSystem.exists(targetUri);
    const currentTargetText = targetExists ? await this.deps.fileSystem.readFile(targetUri) : undefined;
    const currentTargetHash = targetExists ? sha256Hex(currentTargetText ?? "") : undefined;
    const cacheReason = getCacheMissReason(cacheRecord, {
      sourceUri: document.uri,
      targetUri,
      sourceHash,
      targetHash: currentTargetHash,
      configSignature
    });

    if (!cacheReason) {
      this.deps.logger.info("cache: hit");
      return {
        targetUri,
        cacheStatus: "hit"
      };
    }

    this.deps.logger.info(`cache: miss (${cacheReason})`);
    const rawResponse = await this.deps.translationClient.translateDocument(
      document.text,
      {
        model: settings.model,
        baseUrl: settings.baseUrl,
        apiKey,
        systemPrompt: [BUILTIN_SYSTEM_PROMPT, normalizeSystemPrompt(settings.systemPrompt)].filter(Boolean).join("\n\n"),
        promptVersion: PROMPT_VERSION,
        rulesVersion: RULES_VERSION,
        requestTimeoutMs: settings.requestTimeoutMs
      },
      options?.signal
    );

    let translatedMarkdown: string;
    try {
      translatedMarkdown = this.deps.responseParser.extractTranslatedMarkdown(rawResponse);
    } catch (error) {
      this.deps.logger.error(`response snippet: ${truncateForLog(rawResponse)}`);
      throw error;
    }
    this.deps.integrityValidator.validate({
      sourceMarkdown: document.text,
      translatedMarkdown
    });

    const tempPath = join(dirname(targetUri), `${sha256Hex(targetUri)}.${Date.now()}.tmp`);
    await this.deps.fileSystem.writeFile(tempPath, translatedMarkdown);
    await this.deps.fileSystem.rename(tempPath, targetUri);

    const newTargetHash = sha256Hex(translatedMarkdown);
    const record: CacheRecord = {
      sourceUri: document.uri,
      targetUri,
      sourceHash,
      targetHash: newTargetHash,
      configSignature,
      generatedAt: this.now()
    };
    await this.deps.cacheStore.set(document.uri, record);
    this.deps.logger.info(`wrote: ${targetUri}`);

    return {
      targetUri,
      cacheStatus: "miss"
    };
  }
}

function validateDocument(document: SourceDocumentSnapshot): void {
  if (document.isUntitled || !document.isFileSystemResource) {
    throw new Error("Only saved file-system Markdown documents are supported.");
  }

  if (document.languageId !== "markdown") {
    throw new Error("Only Markdown documents are supported.");
  }

  if (!document.fileName.toLowerCase().endsWith(".md")) {
    throw new Error("Only .md Markdown documents are supported.");
  }

  if (document.fileName.toLowerCase().endsWith(".zh-cn.md")) {
    throw new Error("Translated .zh-CN.md files cannot be used as the source document.");
  }

  if (document.text.includes("`````")) {
    throw new Error("Source Markdown contains a 5-backtick fence, which conflicts with the response extraction protocol.");
  }
}

function toTargetMarkdownPath(fileName: string): string {
  return fileName.replace(/\.md$/i, `.${TARGET_LOCALE}.md`);
}

function getCacheMissReason(
  record: CacheRecord | undefined,
  current: {
    sourceUri: string;
    targetUri: string;
    sourceHash: string;
    targetHash?: string;
    configSignature: string;
  }
): string | undefined {
  if (!record) {
    return "no record";
  }

  if (record.sourceUri !== current.sourceUri || record.targetUri !== current.targetUri) {
    return "path changed";
  }

  if (record.sourceHash !== current.sourceHash) {
    return "source changed";
  }

  if (!current.targetHash) {
    return "target missing";
  }

  if (record.targetHash !== current.targetHash) {
    return "target changed";
  }

  if (record.configSignature !== current.configSignature) {
    return "config changed";
  }

  return undefined;
}

export const INTERNAL_CONTRACT = {
  providerId: PROVIDER_ID,
  promptVersion: PROMPT_VERSION,
  rulesVersion: RULES_VERSION
};

function truncateForLog(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 300);
}
