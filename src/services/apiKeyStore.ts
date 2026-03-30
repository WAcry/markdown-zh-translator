import type { SecretStorePort } from "./ports";

const SECRET_KEY = "markdownTranslator.apiKey";

export class ApiKeyStore {
  public constructor(private readonly secrets: SecretStorePort) {}

  public getApiKey(): Promise<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }

  public setApiKey(value: string): Promise<void> {
    return this.secrets.store(SECRET_KEY, value.trim());
  }

  public clearApiKey(): Promise<void> {
    return this.secrets.delete(SECRET_KEY);
  }
}
