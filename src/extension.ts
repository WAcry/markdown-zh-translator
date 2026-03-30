import { promises as fs } from "node:fs";
import * as vscode from "vscode";

import { createClearApiKeyCommand } from "./commands/clearApiKey";
import { createSetApiKeyCommand } from "./commands/setApiKey";
import { createTranslateCurrentDocumentCommand } from "./commands/translateCurrentDocument";
import { ApiKeyStore } from "./services/apiKeyStore";
import { CacheStore } from "./services/cacheStore";
import { MarkdownIntegrityValidator } from "./services/markdownIntegrityValidator";
import { MarkdownResponseParser } from "./services/markdownResponseParser";
import { MarkdownTranslationService } from "./services/markdownTranslationService";
import { OpenAiCompatibleClient } from "./services/openAiCompatibleClient";
import type { ConfigurationPort, DocumentStatePort, FileSystemPort, LoggerPort, SecretStorePort, StateStorePort } from "./services/ports";

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("Markdown Translator");
  context.subscriptions.push(outputChannel);

  const logger: LoggerPort = {
    info: (message) => outputChannel.appendLine(`[info] ${message}`),
    warn: (message) => outputChannel.appendLine(`[warn] ${message}`),
    error: (message) => outputChannel.appendLine(`[error] ${message}`)
  };

  const config: ConfigurationPort = {
    get: (key) => vscode.workspace.getConfiguration("markdownTranslator").get(key)
  };

  const secrets: SecretStorePort = {
    get: (key) => Promise.resolve(context.secrets.get(key)),
    store: (key, value) => Promise.resolve(context.secrets.store(key, value)),
    delete: (key) => Promise.resolve(context.secrets.delete(key))
  };

  const state: StateStorePort = {
    get: (key) => context.globalState.get(key),
    update: (key, value) => Promise.resolve(context.globalState.update(key, value))
  };

  const fileSystem: FileSystemPort = {
    exists: async (filePath) => {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    readFile: async (filePath) => fs.readFile(filePath, "utf8"),
    writeFile: async (filePath, content) => {
      await fs.writeFile(filePath, content, "utf8");
    },
    rename: async (fromPath, toPath) => {
      await fs.rename(fromPath, toPath);
    },
    delete: async (filePath) => {
      await fs.rm(filePath, { force: true });
    }
  };

  const documentState: DocumentStatePort = {
    isDirty: (filePath) =>
      vscode.workspace.textDocuments.some((document) => document.uri.scheme === "file" && document.uri.fsPath === filePath && document.isDirty)
  };

  const apiKeyStore = new ApiKeyStore(secrets);
  const cacheStore = new CacheStore(state);
  const responseParser = new MarkdownResponseParser();
  const integrityValidator = new MarkdownIntegrityValidator();
  const translationClient = new OpenAiCompatibleClient(logger);
  const translationService = new MarkdownTranslationService({
    config,
    apiKeyStore,
    cacheStore,
    translationClient,
    responseParser,
    integrityValidator,
    fileSystem,
    documentState,
    logger
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("markdownTranslator.translateCurrentDocument", createTranslateCurrentDocumentCommand(translationService)),
    vscode.commands.registerCommand("markdownTranslator.setApiKey", createSetApiKeyCommand(apiKeyStore)),
    vscode.commands.registerCommand("markdownTranslator.clearApiKey", createClearApiKeyCommand(apiKeyStore))
  );
}

export function deactivate(): void {
  // Nothing to dispose beyond VS Code subscriptions.
}
