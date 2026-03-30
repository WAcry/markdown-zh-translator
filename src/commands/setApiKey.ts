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

    if (!value) {
      return;
    }

    await apiKeyStore.setApiKey(value);
    await vscode.window.showInformationMessage("Markdown Translator API key stored.");
  };
}
