import { strict as assert } from "node:assert";
import { join } from "node:path";

import { ApiKeyStore } from "../services/apiKeyStore";
import { CacheStore } from "../services/cacheStore";
import { LocalBlobCache } from "../services/localBlobCache";
import { MarkdownResponseParser } from "../services/markdownResponseParser";
import { MarkdownTranslationService } from "../services/markdownTranslationService";
import type { ConfigurationPort, DocumentStatePort, FileSystemPort, LoggerPort, SecretStorePort, SourceDocumentSnapshot, StateStorePort } from "../services/ports";
import { sha256Hex, sha256HexRaw } from "../util/hash";
import { computeConfigSignature } from "../util/translationContract";

class FakeTranslationClient {
  public sourceMarkdowns: string[] = [];

  public async translateDocument(sourceMarkdown: string): Promise<string> {
    this.sourceMarkdowns.push(sourceMarkdown);
    return "`````markdown\n# 欢迎\n\nUse `npm install`.\n`````";
  }
}

describe("MarkdownTranslationService", () => {
  it("rejects unsupported source documents", async () => {
    const service = createService();

    await assert.rejects(
      () =>
        service.translateCurrentDocument({
          uri: "file:///tmp/sample.markdown",
          fileName: "/tmp/sample.markdown",
          languageId: "markdown",
          isUntitled: false,
          isFileSystemResource: true,
          text: "# Hello"
        }),
      /.md/
    );
  });

  it("blocks overwrite when the target document is dirty", async () => {
    const service = createService({
      documentState: {
        isDirty: () => true
      }
    });

    await assert.rejects(
      () => service.translateCurrentDocument(createSourceDocument("# Hello")),
      /save or discard/
    );
  });

  it("force refresh still blocks overwrite when the target document is dirty", async () => {
    const service = createService({
      documentState: {
        isDirty: () => true
      }
    });

    await assert.rejects(
      () => service.translateCurrentDocument(createSourceDocument("# Hello"), { forceRefresh: true }),
      /save or discard/
    );
  });

  it("sends the full markdown once and writes the translated file", async () => {
    const fakeClient = new FakeTranslationClient();
    const files = new Map<string, string>();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files)
    });

    const result = await service.translateCurrentDocument(source);

    assert.equal(result.cacheStatus, "miss");
    assert.equal(fakeClient.sourceMarkdowns.length, 1);
    assert.equal(fakeClient.sourceMarkdowns[0], "# Hello\n\nUse `npm install`.");
    assert.equal(files.get("/tmp/example.zh-CN.md"), "# 欢迎\n\nUse `npm install`.");
    assert.ok(files.has(join("/tmp/blob-cache", `${createDefaultBlobKey(source)}.md`)));
  });

  it("does not call the client when the cache is still valid", async () => {
    const fakeClient = new FakeTranslationClient();
    const targetText = "# 已缓存\n\nUse `npm install`.";
    const files = new Map<string, string>([["/tmp/example.zh-CN.md", targetText]]);
    const state = new Map<string, unknown>();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    const configSignature = defaultConfigSignature();
    state.set("markdownTranslator.cache.v1", {
      [source.uri]: {
        sourceUri: source.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: sha256Hex(source.text),
        targetHash: sha256Hex(targetText),
        configSignature,
        generatedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state
    });

    const result = await service.translateCurrentDocument(source);

    assert.equal(result.cacheStatus, "hit");
    assert.equal(fakeClient.sourceMarkdowns.length, 0);
  });

  it("accepts a legacy raw target hash when line endings differ", async () => {
    const fakeClient = new FakeTranslationClient();
    const targetText = "# cached\r\nUse `npm install`.\r\n";
    const files = new Map<string, string>([["/tmp/example.zh-CN.md", targetText]]);
    const state = new Map<string, unknown>();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    state.set("markdownTranslator.cache.v1", {
      [source.uri]: {
        sourceUri: source.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: sha256Hex(source.text),
        targetHash: sha256HexRaw("# cached\nUse `npm install`.\n"),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state
    });

    const result = await service.translateCurrentDocument(source);

    assert.equal(result.cacheStatus, "hit");
    assert.equal(fakeClient.sourceMarkdowns.length, 0);
  });

  it("accepts a legacy raw CRLF target hash when the current file uses LF", async () => {
    const fakeClient = new FakeTranslationClient();
    const targetText = "# cached\nUse `npm install`.\n";
    const files = new Map<string, string>([["/tmp/example.zh-CN.md", targetText]]);
    const state = new Map<string, unknown>();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    state.set("markdownTranslator.cache.v1", {
      [source.uri]: {
        sourceUri: source.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: sha256Hex(source.text),
        targetHash: sha256HexRaw("# cached\r\nUse `npm install`.\r\n"),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state
    });

    const result = await service.translateCurrentDocument(source);

    assert.equal(result.cacheStatus, "hit");
    assert.equal(fakeClient.sourceMarkdowns.length, 0);
  });

  it("force refresh bypasses an on-disk cache hit and calls the client", async () => {
    const fakeClient = new FakeTranslationClient();
    const targetText = "# 已缓存\n\nUse `npm install`.";
    const files = new Map<string, string>([["/tmp/example.zh-CN.md", targetText]]);
    const state = new Map<string, unknown>();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    state.set("markdownTranslator.cache.v1", {
      [source.uri]: {
        sourceUri: source.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: sha256Hex(source.text),
        targetHash: sha256Hex(targetText),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state
    });

    const result = await service.translateCurrentDocument(source, { forceRefresh: true });

    assert.equal(result.cacheStatus, "miss");
    assert.equal(fakeClient.sourceMarkdowns.length, 1);
  });

  it("restores a missing target file from the local blob cache", async () => {
    const fakeClient = new FakeTranslationClient();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    const blobContent = "# 已缓存\n\nUse `npm install`.";
    const blobKey = createDefaultBlobKey(source);
    const files = new Map<string, string>([[join("/tmp/blob-cache", `${blobKey}.md`), blobContent]]);
    const state = new Map<string, unknown>();
    state.set("markdownTranslator.cache.v1", {
      [source.uri]: {
        sourceUri: source.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: sha256Hex(source.text),
        targetHash: sha256Hex(blobContent),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z",
        blobKey,
        blobHash: sha256Hex(blobContent),
        blobByteSize: Buffer.byteLength(blobContent, "utf8"),
        lastAccessedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state
    });

    const result = await service.translateCurrentDocument(source);

    assert.equal(result.cacheStatus, "hit");
    assert.equal(fakeClient.sourceMarkdowns.length, 0);
    assert.equal(files.get("/tmp/example.zh-CN.md"), blobContent);
  });

  it("force refresh bypasses blob restore and requests a new translation", async () => {
    const fakeClient = new FakeTranslationClient();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    const blobContent = "# 已缓存\n\nUse `npm install`.";
    const blobKey = createDefaultBlobKey(source);
    const files = new Map<string, string>([[join("/tmp/blob-cache", `${blobKey}.md`), blobContent]]);
    const state = new Map<string, unknown>();
    state.set("markdownTranslator.cache.v1", {
      [source.uri]: {
        sourceUri: source.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: sha256Hex(source.text),
        targetHash: sha256Hex(blobContent),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z",
        blobKey,
        blobHash: sha256Hex(blobContent),
        blobByteSize: Buffer.byteLength(blobContent, "utf8"),
        lastAccessedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state
    });

    const result = await service.translateCurrentDocument(source, { forceRefresh: true });

    assert.equal(result.cacheStatus, "miss");
    assert.equal(fakeClient.sourceMarkdowns.length, 1);
    assert.equal(files.get("/tmp/example.zh-CN.md"), "# 欢迎\n\nUse `npm install`.");
  });

  it("restores from the local blob cache even when the API key is missing", async () => {
    const fakeClient = new FakeTranslationClient();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    const blobContent = "# 已缓存\n\nUse `npm install`.";
    const blobKey = createDefaultBlobKey(source);
    const files = new Map<string, string>([[join("/tmp/blob-cache", `${blobKey}.md`), blobContent]]);
    const state = new Map<string, unknown>();
    state.set("markdownTranslator.cache.v1", {
      [source.uri]: {
        sourceUri: source.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: sha256Hex(source.text),
        targetHash: sha256Hex(blobContent),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z",
        blobKey,
        blobHash: sha256Hex(blobContent),
        blobByteSize: Buffer.byteLength(blobContent, "utf8"),
        lastAccessedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state,
      secrets: new Map<string, string>()
    });

    const result = await service.translateCurrentDocument(source);

    assert.equal(result.cacheStatus, "hit");
    assert.equal(fakeClient.sourceMarkdowns.length, 0);
  });

  it("retranslates when the target file changed on disk", async () => {
    const fakeClient = new FakeTranslationClient();
    const targetText = "# 手工修改\n\nUse `npm install`.";
    const files = new Map<string, string>([["/tmp/example.zh-CN.md", targetText]]);
    const state = new Map<string, unknown>();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    state.set("markdownTranslator.cache.v1", {
      [source.uri]: {
        sourceUri: source.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: sha256Hex(source.text),
        targetHash: "stale",
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state
    });

    const result = await service.translateCurrentDocument(source);

    assert.equal(result.cacheStatus, "miss");
    assert.equal(fakeClient.sourceMarkdowns.length, 1);
    assert.equal(files.get("/tmp/example.zh-CN.md"), "# 欢迎\n\nUse `npm install`.");
  });

  it("retranslates when systemPrompt changes the config signature", async () => {
    const fakeClient = new FakeTranslationClient();
    const targetText = "# 已缓存\n\nUse `npm install`.";
    const files = new Map<string, string>([["/tmp/example.zh-CN.md", targetText]]);
    const state = new Map<string, unknown>();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    state.set("markdownTranslator.cache.v1", {
      [source.uri]: {
        sourceUri: source.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: sha256Hex(source.text),
        targetHash: sha256Hex(targetText),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state,
      config: {
        get: <T>(key: string) => {
          switch (key) {
            case "model":
              return "gpt-test" as T;
            case "requestTimeoutMs":
              return 10000 as T;
            case "systemPrompt":
              return "extra" as T;
            default:
              return undefined;
          }
        }
      }
    });

    const result = await service.translateCurrentDocument(source);

    assert.equal(result.cacheStatus, "miss");
    assert.equal(fakeClient.sourceMarkdowns.length, 1);
  });

  it("treats an empty target file as cacheable content instead of a missing file", async () => {
    const fakeClient = new FakeTranslationClient();
    const files = new Map<string, string>([["/tmp/example.zh-CN.md", ""]]);
    const state = new Map<string, unknown>();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    state.set("markdownTranslator.cache.v1", {
      [source.uri]: {
        sourceUri: source.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: sha256Hex(source.text),
        targetHash: sha256Hex(""),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state
    });

    const result = await service.translateCurrentDocument(source);

    assert.equal(result.cacheStatus, "hit");
    assert.equal(fakeClient.sourceMarkdowns.length, 0);
  });

  it("rejects source documents that contain a 5-backtick fence", async () => {
    const service = createService();

    await assert.rejects(
      () => service.translateCurrentDocument(createSourceDocument("`````ts\nconsole.log('x')\n`````")),
      /5-backtick fence/
    );
  });

  it("skips blob persistence when the translated markdown exceeds the max cache size", async () => {
    const fakeClient = new FakeTranslationClient();
    const files = new Map<string, string>();
    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      config: {
        get: <T>(key: string) => {
          switch (key) {
            case "model":
              return "gpt-test" as T;
            case "requestTimeoutMs":
              return 10000 as T;
            case "localBlobCacheMaxBytes":
              return 1 as T;
            default:
              return undefined;
          }
        }
      }
    });

    await service.translateCurrentDocument(createSourceDocument("# Hello\n\nUse `npm install`."));

    assert.equal(Array.from(files.keys()).some((key) => key.includes("/tmp/blob-cache/")), false);
  });

  it("does not restore an existing blob when the current max cache size disables blob caching", async () => {
    const fakeClient = new FakeTranslationClient();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    const blobContent = "# 已缓存\n\nUse `npm install`.";
    const blobKey = createDefaultBlobKey(source);
    const files = new Map<string, string>([[join("/tmp/blob-cache", `${blobKey}.md`), blobContent]]);
    const state = new Map<string, unknown>();
    state.set("markdownTranslator.cache.v1", {
      [source.uri]: {
        sourceUri: source.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: sha256Hex(source.text),
        targetHash: sha256Hex(blobContent),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z",
        blobKey,
        blobHash: sha256Hex(blobContent),
        blobByteSize: Buffer.byteLength(blobContent, "utf8"),
        lastAccessedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state,
      config: {
        get: <T>(key: string) => {
          switch (key) {
            case "model":
              return "gpt-test" as T;
            case "requestTimeoutMs":
              return 10000 as T;
            case "localBlobCacheMaxBytes":
              return 0 as T;
            default:
              return undefined;
          }
        }
      }
    });

    const result = await service.translateCurrentDocument(source);

    assert.equal(result.cacheStatus, "miss");
    assert.equal(fakeClient.sourceMarkdowns.length, 1);
    assert.equal(files.has(join("/tmp/blob-cache", `${blobKey}.md`)), false);
  });

  it("deletes the previous blob when the same source is retranslated with a new source hash", async () => {
    const fakeClient = new FakeTranslationClient();
    const oldSource = createSourceDocument("# Hello\n\nUse `npm install`.");
    const newSource = createSourceDocument("# Hello again\n\nUse `npm install`.");
    const oldBlobKey = createDefaultBlobKey(oldSource);
    const files = new Map<string, string>([
      [join("/tmp/blob-cache", `${oldBlobKey}.md`), "# 已缓存\n\nUse `npm install`."]
    ]);
    const state = new Map<string, unknown>();
    state.set("markdownTranslator.cache.v1", {
      [newSource.uri]: {
        sourceUri: newSource.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: sha256Hex(oldSource.text),
        targetHash: sha256Hex("# 已缓存\n\nUse `npm install`."),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z",
        blobKey: oldBlobKey,
        blobHash: sha256Hex("# 已缓存\n\nUse `npm install`."),
        blobByteSize: Buffer.byteLength("# 已缓存\n\nUse `npm install`.", "utf8"),
        lastAccessedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state
    });

    await service.translateCurrentDocument(newSource);

    assert.equal(files.has(join("/tmp/blob-cache", `${oldBlobKey}.md`)), false);
  });

  it("evicts the least recently used blob when the cache exceeds the configured size", async () => {
    const fakeClient = new FakeTranslationClient();
    const newBlobSize = Buffer.byteLength("# 欢迎\n\nUse `npm install`.", "utf8");
    const files = new Map<string, string>([
      [join("/tmp/blob-cache", "old-a.md"), "AAAA"],
      [join("/tmp/blob-cache", "new-b.md"), "BBBB"]
    ]);
    const state = new Map<string, unknown>();
    state.set("markdownTranslator.cache.v1", {
      "file:///tmp/old-a.md": {
        sourceUri: "file:///tmp/old-a.md",
        targetUri: "/tmp/old-a.zh-CN.md",
        sourceHash: "old-a",
        targetHash: sha256Hex("AAAA"),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z",
        blobKey: "old-a",
        blobHash: sha256Hex("AAAA"),
        blobByteSize: 4,
        lastAccessedAt: "2026-03-30T00:00:00Z"
      },
      "file:///tmp/new-b.md": {
        sourceUri: "file:///tmp/new-b.md",
        targetUri: "/tmp/new-b.zh-CN.md",
        sourceHash: "new-b",
        targetHash: sha256Hex("BBBB"),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z",
        blobKey: "new-b",
        blobHash: sha256Hex("BBBB"),
        blobByteSize: 4,
        lastAccessedAt: "2026-03-30T01:00:00Z"
      }
    });

    const filesWithExisting = createMemoryFileSystem(files);
    const service = createService({
      translationClient: fakeClient,
      fileSystem: filesWithExisting,
      state,
      config: {
        get: <T>(key: string) => {
          switch (key) {
            case "model":
              return "gpt-test" as T;
            case "requestTimeoutMs":
              return 10000 as T;
            case "localBlobCacheMaxBytes":
              return (newBlobSize + 4) as T;
            default:
              return undefined;
          }
        }
      }
    });

    await service.translateCurrentDocument(createSourceDocument("# Hello\n\nUse `npm install`."));

    assert.equal(files.has(join("/tmp/blob-cache", "old-a.md")), false);
    assert.equal(files.has(join("/tmp/blob-cache", "new-b.md")), true);
  });

  it("removes an existing blob when local blob caching is disabled", async () => {
    const fakeClient = new FakeTranslationClient();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    const oldBlobKey = createDefaultBlobKey(source);
    const files = new Map<string, string>([
      [join("/tmp/blob-cache", `${oldBlobKey}.md`), "# 已缓存\n\nUse `npm install`."]
    ]);
    const state = new Map<string, unknown>();
    state.set("markdownTranslator.cache.v1", {
      [source.uri]: {
        sourceUri: source.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: "old-source-hash",
        targetHash: sha256Hex("# 已缓存\n\nUse `npm install`."),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z",
        blobKey: oldBlobKey,
        blobHash: sha256Hex("# 已缓存\n\nUse `npm install`."),
        blobByteSize: Buffer.byteLength("# 已缓存\n\nUse `npm install`.", "utf8"),
        lastAccessedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state,
      config: {
        get: <T>(key: string) => {
          switch (key) {
            case "model":
              return "gpt-test" as T;
            case "requestTimeoutMs":
              return 10000 as T;
            case "localBlobCacheMaxBytes":
              return 0 as T;
            default:
              return undefined;
          }
        }
      }
    });

    await service.translateCurrentDocument(source);

    assert.equal(files.has(join("/tmp/blob-cache", `${oldBlobKey}.md`)), false);
  });

  it("falls back to a network request when blob restore cannot validate the blob hash", async () => {
    const fakeClient = new FakeTranslationClient();
    const source = createSourceDocument("# Hello\n\nUse `npm install`.");
    const blobKey = createDefaultBlobKey(source);
    const files = new Map<string, string>([[join("/tmp/blob-cache", `${blobKey}.md`), "# 被篡改"]]);
    const state = new Map<string, unknown>();
    state.set("markdownTranslator.cache.v1", {
      [source.uri]: {
        sourceUri: source.uri,
        targetUri: "/tmp/example.zh-CN.md",
        sourceHash: sha256Hex(source.text),
        targetHash: sha256Hex("# 已缓存\n\nUse `npm install`."),
        configSignature: defaultConfigSignature(),
        generatedAt: "2026-03-30T00:00:00Z",
        blobKey,
        blobHash: sha256Hex("# 已缓存\n\nUse `npm install`."),
        blobByteSize: Buffer.byteLength("# 已缓存\n\nUse `npm install`.", "utf8"),
        lastAccessedAt: "2026-03-30T00:00:00Z"
      }
    });

    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files),
      state
    });

    const result = await service.translateCurrentDocument(source);

    assert.equal(result.cacheStatus, "miss");
    assert.equal(fakeClient.sourceMarkdowns.length, 1);
  });
});

function defaultConfigSignature(): string {
  return computeConfigSignature({
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-test"
  });
}

function createService(overrides?: {
  config?: ConfigurationPort;
  documentState?: DocumentStatePort;
  fileSystem?: FileSystemPort;
  translationClient?: FakeTranslationClient;
  state?: Map<string, unknown>;
  secrets?: Map<string, string>;
}) {
  const secrets = overrides?.secrets ?? new Map<string, string>([["markdownTranslator.apiKey", "secret"]]);
  const state = overrides?.state ?? new Map<string, unknown>();

  return new MarkdownTranslationService({
    config:
      overrides?.config ??
      ({
        get: <T>(key: string) => {
          switch (key) {
            case "model":
              return "gpt-test" as T;
            case "requestTimeoutMs":
              return 10000 as T;
            default:
              return undefined;
          }
        }
      } satisfies ConfigurationPort),
    apiKeyStore: new ApiKeyStore(createSecretStore(secrets)),
    cacheStore: new CacheStore(createStateStore(state)),
    localBlobCache: new LocalBlobCache(overrides?.fileSystem ?? createMemoryFileSystem(new Map<string, string>()), createLogger(), "/tmp/blob-cache"),
    translationClient: (overrides?.translationClient ?? new FakeTranslationClient()) as never,
    responseParser: new MarkdownResponseParser(),
    fileSystem: overrides?.fileSystem ?? createMemoryFileSystem(new Map<string, string>()),
    documentState: overrides?.documentState ?? { isDirty: () => false },
    logger: createLogger()
  });
}

function createSourceDocument(text: string): SourceDocumentSnapshot {
  return {
    uri: "file:///tmp/example.md",
    fileName: "/tmp/example.md",
    languageId: "markdown",
    isUntitled: false,
    isFileSystemResource: true,
    text
  };
}

function createSecretStore(store: Map<string, string>): SecretStorePort {
  return {
    get: async (key: string) => store.get(key),
    store: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    }
  };
}

function createStateStore(store: Map<string, unknown>): StateStorePort {
  return {
    get: <T>(key: string) => store.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    }
  };
}

function createMemoryFileSystem(files: Map<string, string>): FileSystemPort {
  return {
    exists: async (filePath: string) => files.has(filePath),
    readFile: async (filePath: string) => {
      const value = files.get(filePath);
      if (value === undefined) {
        throw new Error(`Missing file: ${filePath}`);
      }
      return value;
    },
    writeFile: async (filePath: string, content: string) => {
      files.set(filePath, content);
    },
    rename: async (fromPath: string, toPath: string) => {
      const value = files.get(fromPath);
      if (value === undefined) {
        throw new Error(`Missing temp file: ${fromPath}`);
      }
      files.delete(fromPath);
      files.set(toPath, value);
    },
    delete: async (filePath: string) => {
      files.delete(filePath);
    },
    ensureDir: async (_directoryPath: string) => undefined
  };
}

function createDefaultBlobKey(source: SourceDocumentSnapshot): string {
  return new LocalBlobCache(createMemoryFileSystem(new Map<string, string>()), createLogger(), "/tmp/blob-cache").buildBlobKey(
    source.uri,
    sha256Hex(source.text),
    defaultConfigSignature()
  );
}

function createLogger(): LoggerPort {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
