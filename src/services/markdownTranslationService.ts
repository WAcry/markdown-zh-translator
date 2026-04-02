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
  targetFileName: string;
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
    const targetDocument = toTargetDocumentReference(document);
    if (this.deps.documentState.isDirty(targetDocument.targetUri)) {
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
    const targetExists = await this.deps.fileSystem.exists(targetDocument.targetFileName);
    const currentTargetText = targetExists ? await this.deps.fileSystem.readFile(targetDocument.targetFileName) : undefined;
    const cacheReason = getCacheMissReason(cacheRecord, {
      sourceUri: document.uri,
      targetUri: targetDocument.targetUri,
      targetFileName: targetDocument.targetFileName,
      sourceText: document.text,
      targetText: currentTargetText,
      configSignature
    });

    if (!options?.forceRefresh && !cacheReason) {
      this.deps.logger.info("cache: hit");
      return {
        targetUri: targetDocument.targetUri,
        targetFileName: targetDocument.targetFileName,
        cacheStatus: "hit"
      };
    }

    if (
      !options?.forceRefresh &&
      cacheRecord &&
      cacheRecord.sourceUri === document.uri &&
      matchesTargetDocument(cacheRecord, targetDocument) &&
      matchesStoredTextHash(document.text, cacheRecord.sourceHash) &&
      cacheRecord.configSignature === configSignature &&
      !targetExists
    ) {
      cacheRecord = await this.enforceCurrentBlobLimit(document.uri, cacheRecord, settings.localBlobCacheMaxBytes);
      const restoredMarkdown = await this.deps.localBlobCache.read(cacheRecord);
      if (restoredMarkdown !== undefined) {
        await this.writeTargetFile(targetDocument.targetFileName, restoredMarkdown);
        const touchedRecord = this.deps.localBlobCache.touch(cacheRecord);
        await this.deps.cacheStore.set(document.uri, touchedRecord);
        this.deps.logger.info("cache: hit (restored from local blob)");
        return {
          targetUri: targetDocument.targetUri,
          targetFileName: targetDocument.targetFileName,
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

    await this.writeTargetFile(targetDocument.targetFileName, translatedMarkdown);

    const newTargetHash = sha256Hex(translatedMarkdown);
    const record: CacheRecord = {
      sourceUri: document.uri,
      targetUri: targetDocument.targetUri,
      targetFileName: targetDocument.targetFileName,
      sourceHash,
      targetHash: newTargetHash,
      configSignature,
      generatedAt: this.now()
    };
    const recordWithBlob = await this.persistBlobAndPrune(cacheRecord, record, translatedMarkdown, settings.localBlobCacheMaxBytes);
    await this.deps.cacheStore.set(document.uri, recordWithBlob);
    this.deps.logger.info(`wrote: ${targetDocument.targetUri}`);

    return {
      targetUri: targetDocument.targetUri,
      targetFileName: targetDocument.targetFileName,
      cacheStatus: "miss"
    };
  }

  private async writeTargetFile(targetFileName: string, translatedMarkdown: string): Promise<void> {
    const tempPath = join(dirname(targetFileName), `${sha256Hex(targetFileName)}.${Date.now()}.tmp`);
    await this.deps.fileSystem.ensureDir(dirname(targetFileName));
    await this.deps.fileSystem.writeFile(tempPath, translatedMarkdown);
    try {
      await this.deps.fileSystem.rename(tempPath, targetFileName);
    } catch (error) {
      try {
        await this.deps.fileSystem.delete(tempPath);
      } catch {
        // Best-effort cleanup only.
      }

      throw error;
    }
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

  const hasMarkdownLanguage = document.languageId === "markdown";
  const hasMarkdownExtension = document.fileName.toLowerCase().endsWith(".md");
  if (!hasMarkdownLanguage && !hasMarkdownExtension) {
    throw new Error("Only Markdown documents or .md files are supported.");
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

interface TargetDocumentReference {
  targetUri: string;
  targetFileName: string;
}

function toTargetDocumentReference(document: SourceDocumentSnapshot): TargetDocumentReference {
  return {
    targetUri: toTargetMarkdownUri(document.uri),
    targetFileName: toTargetMarkdownPath(document.fileName)
  };
}

function toTargetMarkdownUri(sourceUri: string): string {
  return sourceUri.replace(/([^/?#]+)(?=([?#].*)?$)/, (encodedBaseName) => {
    const sourceBaseName = decodeURIComponent(encodedBaseName);
    return encodeURIComponent(toTargetMarkdownPath(sourceBaseName));
  });
}

function matchesTargetDocument(record: Pick<CacheRecord, "targetUri" | "targetFileName">, current: TargetDocumentReference): boolean {
  if (record.targetFileName !== undefined) {
    return record.targetUri === current.targetUri && record.targetFileName === current.targetFileName;
  }

  return record.targetUri === current.targetUri || record.targetUri === current.targetFileName;
}

function getCacheMissReason(
  record: CacheRecord | undefined,
  current: TargetDocumentReference & {
    sourceUri: string;
    sourceText: string;
    targetText?: string;
    configSignature: string;
  }
): string | undefined {
  if (!record) {
    return "no record";
  }

  if (record.sourceUri !== current.sourceUri || !matchesTargetDocument(record, current)) {
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
    targetFileName: record.targetFileName,
    sourceHash: record.sourceHash,
    targetHash: record.targetHash,
    configSignature: record.configSignature,
    generatedAt: record.generatedAt
  };
}
