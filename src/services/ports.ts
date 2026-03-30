export interface SourceDocumentSnapshot {
  uri: string;
  fileName: string;
  languageId: string;
  isUntitled: boolean;
  isFileSystemResource: boolean;
  text: string;
}

export interface ClosedDocumentSnapshot {
  uri: string;
  fileName: string;
  isUntitled: boolean;
  isFileSystemResource: boolean;
}

export interface FileSystemPort {
  exists(filePath: string): Promise<boolean>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  delete(filePath: string): Promise<void>;
  ensureDir(directoryPath: string): Promise<void>;
}

export interface DocumentStatePort {
  isDirty(filePath: string): boolean;
}

export interface LoggerPort {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SecretStorePort {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface StateStorePort {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void> | void;
}

export interface ConfigurationPort {
  get<T>(key: string): T | undefined;
}
