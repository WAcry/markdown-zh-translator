import type { StateStorePort } from "./ports";

export interface CacheRecord {
  sourceUri: string;
  targetUri: string;
  sourceHash: string;
  targetHash: string;
  configSignature: string;
  generatedAt: string;
}

const CACHE_KEY = "markdownTranslator.cache.v1";

export class CacheStore {
  public constructor(private readonly stateStore: StateStorePort) {}

  public async get(sourceUri: string): Promise<CacheRecord | undefined> {
    const all = this.stateStore.get<Record<string, CacheRecord>>(CACHE_KEY) ?? {};
    return all[sourceUri];
  }

  public async set(sourceUri: string, record: CacheRecord): Promise<void> {
    const all = this.stateStore.get<Record<string, CacheRecord>>(CACHE_KEY) ?? {};
    all[sourceUri] = record;
    await Promise.resolve(this.stateStore.update(CACHE_KEY, all));
  }

  public async delete(sourceUri: string): Promise<void> {
    const all = this.stateStore.get<Record<string, CacheRecord>>(CACHE_KEY) ?? {};
    delete all[sourceUri];
    await Promise.resolve(this.stateStore.update(CACHE_KEY, all));
  }
}
