import { strict as assert } from "node:assert";

import { CacheStore } from "../services/cacheStore";
import { TranslatedDocumentLifecycleManager } from "../services/translatedDocumentLifecycleManager";
import type { FileSystemPort, LoggerPort, StateStorePort } from "../services/ports";
import { sha256Hex, sha256HexRaw } from "../util/hash";

describe("TranslatedDocumentLifecycleManager", () => {
  it("deletes an untouched generated translated document on close", async () => {
    const filePath = "/tmp/example.zh-CN.md";
    const content = "# 已缓存";
    const files = new Map<string, string>([[filePath, content]]);
    const cacheStore = new CacheStore(
      createStateStore(
        new Map<string, unknown>([
          [
            "markdownTranslator.cache.v1",
            {
              "file:///tmp/example.md": {
                sourceUri: "file:///tmp/example.md",
                targetUri: filePath,
                sourceHash: "source",
                targetHash: sha256Hex(content),
                configSignature: "signature",
                generatedAt: "2026-03-30T00:00:00Z"
              }
            }
          ]
        ])
      )
    );

    const manager = new TranslatedDocumentLifecycleManager(cacheStore, createMemoryFileSystem(files), createLogger());
    const deleted = await manager.handleClosedTranslatedDocument({
      uri: "file:///tmp/example.zh-CN.md",
      fileName: filePath,
      isUntitled: false,
      isFileSystemResource: true
    });

    assert.equal(deleted, true);
    assert.equal(files.has(filePath), false);
  });

  it("deletes an untouched generated translated document even when the file uses CRLF", async () => {
    const filePath = "/tmp/example.zh-CN.md";
    const files = new Map<string, string>([[filePath, "# cached\r\nline\r\n"]]);
    const cacheStore = new CacheStore(
      createStateStore(
        new Map<string, unknown>([
          [
            "markdownTranslator.cache.v1",
            {
              "file:///tmp/example.md": {
                sourceUri: "file:///tmp/example.md",
                targetUri: filePath,
                sourceHash: "source",
                targetHash: sha256Hex("# cached\nline\n"),
                configSignature: "signature",
                generatedAt: "2026-03-30T00:00:00Z"
              }
            }
          ]
        ])
      )
    );

    const manager = new TranslatedDocumentLifecycleManager(cacheStore, createMemoryFileSystem(files), createLogger());
    const deleted = await manager.handleClosedTranslatedDocument({
      uri: "file:///tmp/example.zh-CN.md",
      fileName: filePath,
      isUntitled: false,
      isFileSystemResource: true
    });

    assert.equal(deleted, true);
    assert.equal(files.has(filePath), false);
  });

  it("deletes an untouched generated translated document when the stored hash came from legacy CRLF content", async () => {
    const filePath = "/tmp/example.zh-CN.md";
    const files = new Map<string, string>([[filePath, "# cached\nline\n"]]);
    const cacheStore = new CacheStore(
      createStateStore(
        new Map<string, unknown>([
          [
            "markdownTranslator.cache.v1",
            {
              "file:///tmp/example.md": {
                sourceUri: "file:///tmp/example.md",
                targetUri: filePath,
                sourceHash: "source",
                targetHash: sha256HexRaw("# cached\r\nline\r\n"),
                configSignature: "signature",
                generatedAt: "2026-03-30T00:00:00Z"
              }
            }
          ]
        ])
      )
    );

    const manager = new TranslatedDocumentLifecycleManager(cacheStore, createMemoryFileSystem(files), createLogger());
    const deleted = await manager.handleClosedTranslatedDocument({
      uri: "file:///tmp/example.zh-CN.md",
      fileName: filePath,
      isUntitled: false,
      isFileSystemResource: true
    });

    assert.equal(deleted, true);
    assert.equal(files.has(filePath), false);
  });

  it("keeps a translated document that the user modified and saved", async () => {
    const filePath = "/tmp/example.zh-CN.md";
    const files = new Map<string, string>([[filePath, "# 用户修改"]]);
    const cacheStore = new CacheStore(
      createStateStore(
        new Map<string, unknown>([
          [
            "markdownTranslator.cache.v1",
            {
              "file:///tmp/example.md": {
                sourceUri: "file:///tmp/example.md",
                targetUri: filePath,
                sourceHash: "source",
                targetHash: sha256Hex("# 原始生成"),
                configSignature: "signature",
                generatedAt: "2026-03-30T00:00:00Z"
              }
            }
          ]
        ])
      )
    );

    const manager = new TranslatedDocumentLifecycleManager(cacheStore, createMemoryFileSystem(files), createLogger());
    const deleted = await manager.handleClosedTranslatedDocument({
      uri: "file:///tmp/example.zh-CN.md",
      fileName: filePath,
      isUntitled: false,
      isFileSystemResource: true
    });

    assert.equal(deleted, false);
    assert.equal(files.has(filePath), true);
  });

  it("matches remote translated documents by full URI before falling back to legacy path-only cache entries", async () => {
    const filePath = "/tmp/example.zh-CN.md";
    const content = "# remote cached";
    const files = new Map<string, string>([[filePath, content]]);
    const cacheStore = new CacheStore(
      createStateStore(
        new Map<string, unknown>([
          [
            "markdownTranslator.cache.v1",
            {
              "vscode-remote://ssh-remote+alpha/tmp/example.md": {
                sourceUri: "vscode-remote://ssh-remote+alpha/tmp/example.md",
                targetUri: "vscode-remote://ssh-remote+alpha/tmp/example.zh-CN.md",
                targetFileName: filePath,
                sourceHash: "source-a",
                targetHash: sha256Hex("# alpha cached"),
                configSignature: "signature",
                generatedAt: "2026-03-30T00:00:00Z"
              },
              "vscode-remote://ssh-remote+beta/tmp/example.md": {
                sourceUri: "vscode-remote://ssh-remote+beta/tmp/example.md",
                targetUri: "vscode-remote://ssh-remote+beta/tmp/example.zh-CN.md",
                targetFileName: filePath,
                sourceHash: "source-b",
                targetHash: sha256Hex(content),
                configSignature: "signature",
                generatedAt: "2026-03-30T00:00:00Z"
              }
            }
          ]
        ])
      )
    );

    const manager = new TranslatedDocumentLifecycleManager(cacheStore, createMemoryFileSystem(files), createLogger());
    const deleted = await manager.handleClosedTranslatedDocument({
      uri: "vscode-remote://ssh-remote+beta/tmp/example.zh-CN.md",
      fileName: filePath,
      isUntitled: false,
      isFileSystemResource: true
    });

    assert.equal(deleted, true);
    assert.equal(files.has(filePath), false);
  });
});

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
    readFile: async (filePath: string) => files.get(filePath) ?? "",
    writeFile: async (filePath: string, content: string) => {
      files.set(filePath, content);
    },
    rename: async (fromPath: string, toPath: string) => {
      const value = files.get(fromPath);
      if (value === undefined) {
        throw new Error(`Missing file: ${fromPath}`);
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

function createLogger(): LoggerPort {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
