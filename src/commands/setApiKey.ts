import * as vscode from "vscode";

import type { ApiKeyStore } from "../services/apiKeyStore";

export function createSetApiKeyCommand(apiKeyStore: ApiKeyStore): () => Promise<void> {
  return async () => {
    const value = await vscode.window.showInputBox({
      title: "Markdown Translator API Key",
      prompt: "Enter the API key for the OpenAI-compatible endpoint",
      ignoreFocusOut: true,
      password: true
    });

    if (value === undefined) {
      return;
    }

    const normalized = value.trim();
    if (!normalized) {
      await vscode.window.showWarningMessage("API key cannot be empty.");
      return;
    }

    await apiKeyStore.setApiKey(normalized);
    await vscode.window.showInformationMessage("Markdown Translator API key stored.");
  };
}
