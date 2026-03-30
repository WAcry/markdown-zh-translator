import type { StateStorePort } from "./ports";

export interface CacheRecord {
  sourceUri: string;
  targetUri: string;
  sourceHash: string;
  targetHash: string;
  configSignature: string;
  generatedAt: string;
  blobKey?: string;
  blobHash?: string;
  blobByteSize?: number;
  lastAccessedAt?: string;
}

const CACHE_KEY = "markdownTranslator.cache.v1";

export class CacheStore {
  public constructor(private readonly stateStore: StateStorePort) {}

  public async get(sourceUri: string): Promise<CacheRecord | undefined> {
    const all = this.stateStore.get<Record<string, CacheRecord>>(CACHE_KEY) ?? {};
    return all[sourceUri];
  }

  public async getAll(): Promise<Record<string, CacheRecord>> {
    return this.stateStore.get<Record<string, CacheRecord>>(CACHE_KEY) ?? {};
  }

  public async set(sourceUri: string, record: CacheRecord): Promise<void> {
    const all = this.stateStore.get<Record<string, CacheRecord>>(CACHE_KEY) ?? {};
    all[sourceUri] = record;
    await Promise.resolve(this.stateStore.update(CACHE_KEY, all));
  }

  public async replaceAll(records: Record<string, CacheRecord>): Promise<void> {
    await Promise.resolve(this.stateStore.update(CACHE_KEY, records));
  }

  public async delete(sourceUri: string): Promise<void> {
    const all = this.stateStore.get<Record<string, CacheRecord>>(CACHE_KEY) ?? {};
    delete all[sourceUri];
    await Promise.resolve(this.stateStore.update(CACHE_KEY, all));
  }

  public async findByTargetUri(targetUri: string): Promise<[string, CacheRecord] | undefined> {
    const all = await this.getAll();
    for (const [sourceUri, record] of Object.entries(all)) {
      if (record.targetUri === targetUri) {
        return [sourceUri, record];
      }
    }
    return undefined;
  }
}
