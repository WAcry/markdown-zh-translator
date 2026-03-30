import type { CacheStore } from "./cacheStore";
import type { ClosedDocumentSnapshot, FileSystemPort, LoggerPort } from "./ports";
import { matchesStoredTextHash } from "../util/hash";

export class TranslatedDocumentLifecycleManager {
  public constructor(
    private readonly cacheStore: CacheStore,
    private readonly fileSystem: FileSystemPort,
    private readonly logger: LoggerPort
  ) {}

  public async handleClosedTranslatedDocument(document: ClosedDocumentSnapshot): Promise<boolean> {
    if (document.isUntitled || !document.isFileSystemResource) {
      return false;
    }

    if (!document.fileName.toLowerCase().endsWith(".zh-cn.md")) {
      return false;
    }

    const recordEntry = await this.cacheStore.findByTargetUri(document.fileName);
    if (!recordEntry) {
      return false;
    }

    if (!(await this.fileSystem.exists(document.fileName))) {
      return false;
    }

    const currentText = await this.fileSystem.readFile(document.fileName);
    if (!matchesStoredTextHash(currentText, recordEntry[1].targetHash)) {
      this.logger.info("target: keep modified translated file on close");
      return false;
    }

    await this.fileSystem.delete(document.fileName);
    this.logger.info(`target: deleted on close ${document.fileName}`);
    return true;
  }
}
