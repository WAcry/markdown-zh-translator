import { join } from "node:path";

import type { CacheRecord } from "./cacheStore";
import type { FileSystemPort, LoggerPort } from "./ports";
import { matchesStoredTextHash, sha256Hex } from "../util/hash";

export interface BlobMetadata {
  blobKey: string;
  blobHash: string;
  blobByteSize: number;
  lastAccessedAt: string;
}

export class LocalBlobCache {
  public constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly logger: LoggerPort,
    private readonly rootDirectoryPath: string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  public buildBlobKey(sourceUri: string, sourceHash: string, configSignature: string): string {
    return sha256Hex([sourceUri, sourceHash, configSignature].join("\n"));
  }

  public async read(record: CacheRecord): Promise<string | undefined> {
    if (!record.blobKey || !record.blobHash) {
      return undefined;
    }

    const blobPath = this.toBlobPath(record.blobKey);
    if (!(await this.fileSystem.exists(blobPath))) {
      return undefined;
    }

    const content = await this.fileSystem.readFile(blobPath);
    if (!matchesStoredTextHash(content, record.blobHash)) {
      this.logger.warn(`blob: hash mismatch ${record.blobKey}`);
      return undefined;
    }

    return content;
  }

  public async write(blobKey: string, content: string, maxBytes: number): Promise<BlobMetadata | undefined> {
    const blobByteSize = Buffer.byteLength(content, "utf8");
    if (blobByteSize > maxBytes) {
      this.logger.info(`blob: skipped (over max size) ${blobByteSize}`);
      return undefined;
    }

    await this.fileSystem.ensureDir(this.rootDirectoryPath);
    await this.fileSystem.writeFile(this.toBlobPath(blobKey), content);

    return {
      blobKey,
      blobHash: sha256Hex(content),
      blobByteSize,
      lastAccessedAt: this.now()
    };
  }

  public async delete(blobKey: string): Promise<void> {
    await this.fileSystem.delete(this.toBlobPath(blobKey));
  }

  public touch(record: CacheRecord): CacheRecord {
    return {
      ...record,
      lastAccessedAt: this.now()
    };
  }

  private toBlobPath(blobKey: string): string {
    return join(this.rootDirectoryPath, `${blobKey}.md`);
  }
}
