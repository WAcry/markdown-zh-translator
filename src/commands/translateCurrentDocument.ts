import * as vscode from "vscode";

import type { MarkdownTranslationService } from "../services/markdownTranslationService";
import type { SourceDocumentSnapshot } from "../services/ports";

export function createTranslateCurrentDocumentCommand(service: MarkdownTranslationService): () => Promise<void> {
  return async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.window.showWarningMessage("Open a Markdown document before translating.");
      return;
    }

    const document = toSourceDocumentSnapshot(editor.document);
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Translating Markdown to Chinese"
        },
        async () => service.translateCurrentDocument(document)
      );

      const targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(result.targetUri));
      await vscode.window.showTextDocument(targetDocument, { preview: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Translation failed";
      await vscode.window.showErrorMessage(message);
    }
  };
}

function toSourceDocumentSnapshot(document: vscode.TextDocument): SourceDocumentSnapshot {
  return {
    uri: document.uri.toString(),
    fileName: document.uri.fsPath,
    languageId: document.languageId,
    isUntitled: document.isUntitled,
    isFileSystemResource: document.uri.scheme === "file",
    text: document.getText()
  };
}
