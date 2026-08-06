import * as vscode from 'vscode';

// Best-effort document formatting after an edit. Runs the language's format
// provider and applies its edits; formatting failures never fail a step (a file
// with no formatter is normal), so everything here is swallowed.
export async function formatDocument(document: vscode.TextDocument): Promise<void> {
  try {
    const cfg = vscode.workspace.getConfiguration('editor', document.uri);
    const options: vscode.FormattingOptions = {
      tabSize: cfg.get<number>('tabSize', 2),
      insertSpaces: cfg.get<boolean>('insertSpaces', true),
    };
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>(
      'vscode.executeFormatDocumentProvider',
      document.uri,
      options,
    );
    if (edits && edits.length) {
      const we = new vscode.WorkspaceEdit();
      we.set(document.uri, edits);
      await vscode.workspace.applyEdit(we);
    }
  } catch {
    /* formatting is best-effort */
  }
}
