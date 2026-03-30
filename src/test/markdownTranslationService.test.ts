import { strict as assert } from "node:assert";

import { ApiKeyStore } from "../services/apiKeyStore";
import { CacheStore } from "../services/cacheStore";
import { MarkdownIntegrityValidator } from "../services/markdownIntegrityValidator";
import { MarkdownResponseParser } from "../services/markdownResponseParser";
import { MarkdownTranslationService } from "../services/markdownTranslationService";
import type { ConfigurationPort, DocumentStatePort, FileSystemPort, LoggerPort, SecretStorePort, SourceDocumentSnapshot, StateStorePort } from "../services/ports";
import { sha256Hex } from "../util/hash";
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

  it("sends the full markdown once and writes the translated file", async () => {
    const fakeClient = new FakeTranslationClient();
    const files = new Map<string, string>();
    const service = createService({
      translationClient: fakeClient,
      fileSystem: createMemoryFileSystem(files)
    });

    const result = await service.translateCurrentDocument(createSourceDocument("# Hello\n\nUse `npm install`."));

    assert.equal(result.cacheStatus, "miss");
    assert.equal(fakeClient.sourceMarkdowns.length, 1);
    assert.equal(fakeClient.sourceMarkdowns[0], "# Hello\n\nUse `npm install`.");
    assert.equal(files.get("/tmp/example.zh-CN.md"), "# 欢迎\n\nUse `npm install`.");
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
}) {
  const secrets = new Map<string, string>([["markdownTranslator.apiKey", "secret"]]);
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
    translationClient: (overrides?.translationClient ?? new FakeTranslationClient()) as never,
    responseParser: new MarkdownResponseParser(),
    integrityValidator: new MarkdownIntegrityValidator(),
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
    }
  };
}

function createLogger(): LoggerPort {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
