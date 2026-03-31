import { dirname, join } from "node:path";

import type { ApiKeyStore } from "./apiKeyStore";
import type { CacheRecord } from "./cacheStore";
import type { CacheStore } from "./cacheStore";
import type { LocalBlobCache } from "./localBlobCache";
import type { MarkdownResponseParser } from "./markdownResponseParser";
import type { TranslationClient } from "./openAiCompatibleClient";
import type { ConfigurationPort, DocumentStatePort, FileSystemPort, LoggerPort, SourceDocumentSnapshot } from "./ports";
import { matchesStoredTextHash, sha256Hex } from "../util/hash";
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
  localBlobCache: LocalBlobCache;
  translationClient: TranslationClient;
  responseParser: MarkdownResponseParser;
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
    options?: { signal?: AbortSignal; forceRefresh?: boolean }
  ): Promise<TranslationRunResult> {
    validateDocument(document);

    const settings = readExtensionSettings(this.deps.config);
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

    let cacheRecord = await this.deps.cacheStore.get(document.uri);
    const targetExists = await this.deps.fileSystem.exists(targetUri);
    const currentTargetText = targetExists ? await this.deps.fileSystem.readFile(targetUri) : undefined;
    const cacheReason = getCacheMissReason(cacheRecord, {
      sourceUri: document.uri,
      targetUri,
      sourceText: document.text,
      targetText: currentTargetText,
      configSignature
    });

    if (!options?.forceRefresh && !cacheReason) {
      this.deps.logger.info("cache: hit");
      return {
        targetUri,
        cacheStatus: "hit"
      };
    }

    if (
      !options?.forceRefresh &&
      cacheRecord &&
      cacheRecord.sourceUri === document.uri &&
      cacheRecord.targetUri === targetUri &&
      matchesStoredTextHash(document.text, cacheRecord.sourceHash) &&
      cacheRecord.configSignature === configSignature &&
      !targetExists
    ) {
      cacheRecord = await this.enforceCurrentBlobLimit(document.uri, cacheRecord, settings.localBlobCacheMaxBytes);
      const restoredMarkdown = await this.deps.localBlobCache.read(cacheRecord);
      if (restoredMarkdown !== undefined) {
        await this.writeTargetFile(targetUri, restoredMarkdown);
        const touchedRecord = this.deps.localBlobCache.touch(cacheRecord);
        await this.deps.cacheStore.set(document.uri, touchedRecord);
        this.deps.logger.info("cache: hit (restored from local blob)");
        return {
          targetUri,
          cacheStatus: "hit"
        };
      }
    }

    this.deps.logger.info(options?.forceRefresh ? "cache: miss (force refresh)" : `cache: miss (${cacheReason})`);
    const apiKey = (await this.deps.apiKeyStore.getApiKey())?.trim();
    if (!apiKey) {
      throw new Error("Missing API key. Run 'Markdown Translator: Set API Key' first.");
    }

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

    await this.writeTargetFile(targetUri, translatedMarkdown);

    const newTargetHash = sha256Hex(translatedMarkdown);
    const record: CacheRecord = {
      sourceUri: document.uri,
      targetUri,
      sourceHash,
      targetHash: newTargetHash,
      configSignature,
      generatedAt: this.now()
    };
    const recordWithBlob = await this.persistBlobAndPrune(cacheRecord, record, translatedMarkdown, settings.localBlobCacheMaxBytes);
    await this.deps.cacheStore.set(document.uri, recordWithBlob);
    this.deps.logger.info(`wrote: ${targetUri}`);

    return {
      targetUri,
      cacheStatus: "miss"
    };
  }

  private async writeTargetFile(targetUri: string, translatedMarkdown: string): Promise<void> {
    const tempPath = join(dirname(targetUri), `${sha256Hex(targetUri)}.${Date.now()}.tmp`);
    await this.deps.fileSystem.ensureDir(dirname(targetUri));
    await this.deps.fileSystem.writeFile(tempPath, translatedMarkdown);
    await this.deps.fileSystem.rename(tempPath, targetUri);
  }

  private async persistBlobAndPrune(
    previousRecord: CacheRecord | undefined,
    record: CacheRecord,
    translatedMarkdown: string,
    maxBytes: number
  ): Promise<CacheRecord> {
    if (maxBytes <= 0) {
      await this.deleteObsoleteBlob(previousRecord);
      return clearBlobMetadata(record);
    }

    const blobKey = this.deps.localBlobCache.buildBlobKey(record.sourceUri, record.sourceHash, record.configSignature);
    const blobMetadata = await this.deps.localBlobCache.write(blobKey, translatedMarkdown, maxBytes);
    if (!blobMetadata) {
      await this.deleteObsoleteBlob(previousRecord);
      return clearBlobMetadata(record);
    }

    await this.deleteObsoleteBlob(previousRecord, blobKey);

    const allRecords = await this.deps.cacheStore.getAll();
    const nextRecord: CacheRecord = {
      ...record,
      ...blobMetadata
    };
    allRecords[record.sourceUri] = nextRecord;

    const evictable = Object.entries(allRecords)
      .filter(([, value]) => value.blobKey && value.blobByteSize && value.lastAccessedAt)
      .sort((left, right) => String(left[1].lastAccessedAt).localeCompare(String(right[1].lastAccessedAt)));

    let totalBytes = evictable.reduce((sum, [, value]) => sum + Number(value.blobByteSize ?? 0), 0);
    for (const [sourceUri, value] of evictable) {
      if (totalBytes <= maxBytes) {
        break;
      }

      if (!value.blobKey || !value.blobByteSize) {
        continue;
      }

      await this.deps.localBlobCache.delete(value.blobKey);
      totalBytes -= value.blobByteSize;
      allRecords[sourceUri] = clearBlobMetadata(value);
      this.deps.logger.info(`blob: evicted (lru) ${value.blobKey}`);
    }

    await this.deps.cacheStore.replaceAll(allRecords);
    return allRecords[record.sourceUri] ?? clearBlobMetadata(record);
  }

  private async deleteObsoleteBlob(previousRecord: CacheRecord | undefined, nextBlobKey?: string): Promise<void> {
    if (!previousRecord?.blobKey) {
      return;
    }

    if (previousRecord.blobKey === nextBlobKey) {
      return;
    }

    await this.deps.localBlobCache.delete(previousRecord.blobKey);
  }

  private async enforceCurrentBlobLimit(sourceUri: string, record: CacheRecord, maxBytes: number): Promise<CacheRecord> {
    if (!record.blobKey || record.blobByteSize === undefined) {
      return record;
    }

    if (maxBytes > 0 && record.blobByteSize <= maxBytes) {
      return record;
    }

    await this.deps.localBlobCache.delete(record.blobKey);
    const nextRecord = clearBlobMetadata(record);
    await this.deps.cacheStore.set(sourceUri, nextRecord);
    this.deps.logger.info(`blob: evicted (over current limit) ${record.blobKey}`);
    return nextRecord;
  }
}

function validateDocument(document: SourceDocumentSnapshot): void {
  if (document.isUntitled) {
    throw new Error("Only saved Markdown documents are supported.");
  }

  if (document.languageId !== "markdown") {
    throw new Error("Only Markdown documents are supported.");
  }

  if (document.uriScheme !== "file" && document.uriScheme !== "vscode-remote") {
    throw new Error("Only path-backed Markdown documents are supported.");
  }

  if (document.fileName.toLowerCase().endsWith(".zh-cn.md")) {
    throw new Error("Translated .zh-CN.md files cannot be used as the source document.");
  }

  if (document.text.includes("`````")) {
    throw new Error("Source Markdown contains a 5-backtick fence, which conflicts with the response extraction protocol.");
  }
}

function toTargetMarkdownPath(fileName: string): string {
  return fileName.toLowerCase().endsWith(".md") ? fileName.replace(/\.md$/i, `.${TARGET_LOCALE}.md`) : `${fileName}.${TARGET_LOCALE}.md`;
}

function getCacheMissReason(
  record: CacheRecord | undefined,
  current: {
    sourceUri: string;
    targetUri: string;
    sourceText: string;
    targetText?: string;
    configSignature: string;
  }
): string | undefined {
  if (!record) {
    return "no record";
  }

  if (record.sourceUri !== current.sourceUri || record.targetUri !== current.targetUri) {
    return "path changed";
  }

  if (!matchesStoredTextHash(current.sourceText, record.sourceHash)) {
    return "source changed";
  }

  if (current.targetText === undefined) {
    return "target missing";
  }

  if (!matchesStoredTextHash(current.targetText, record.targetHash)) {
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

function clearBlobMetadata(record: CacheRecord): CacheRecord {
  return {
    sourceUri: record.sourceUri,
    targetUri: record.targetUri,
    sourceHash: record.sourceHash,
    targetHash: record.targetHash,
    configSignature: record.configSignature,
    generatedAt: record.generatedAt
  };
}
