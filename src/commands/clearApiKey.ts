import * as vscode from "vscode";

import type { ApiKeyStore } from "../services/apiKeyStore";

export function createClearApiKeyCommand(apiKeyStore: ApiKeyStore): () => Promise<void> {
  return async () => {
    await apiKeyStore.clearApiKey();
    await vscode.window.showInformationMessage("Markdown Translator API key cleared.");
  };
}
