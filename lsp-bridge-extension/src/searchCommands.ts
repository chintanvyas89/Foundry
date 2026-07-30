import * as vscode from 'vscode';
import { SearchClient, SearchResult } from './searchClient';

// Wires up the two no-LLM search commands: search-by-meaning (type a query)
// and find-similar (use the current selection as the query). Both render the
// same ranked QuickPick with live preview and jump-to-line.
export function registerSearchCommands(
  context: vscode.ExtensionContext,
  client: SearchClient,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sweSearch.searchByMeaning', () => searchByMeaning(client)),
    vscode.commands.registerCommand('sweSearch.findSimilar', () => findSimilar(client)),
  );
}

async function searchByMeaning(client: SearchClient): Promise<void> {
  const query = await vscode.window.showInputBox({
    title: 'Semantic search',
    prompt: 'Describe the code you are looking for',
    placeHolder: 'where JWT tokens are validated',
  });
  if (!query || !query.trim()) return;
  await runSearch(client, query, query);
}

async function findSimilar(client: SearchClient): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Open a file and select code to find similar code.');
    return;
  }
  const selection = editor.selection;
  const text = selection.isEmpty
    ? editor.document.lineAt(selection.active.line).text
    : editor.document.getText(selection);
  if (!text.trim()) {
    vscode.window.showInformationMessage('Select some code to find similar code.');
    return;
  }
  await runSearch(client, text, 'code similar to the selection');
}

// `query` is what gets embedded; `label` is a short human description of the
// search, kept visible in the results title (the QuickPick input box itself is
// left empty so it can filter the results — putting the query back there would
// make VS Code hide any result that doesn't fuzzy-match it).
async function runSearch(client: SearchClient, query: string, label: string): Promise<void> {
  const topK = vscode.workspace.getConfiguration('sweSearch').get<number>('topK') ?? 8;

  let results: SearchResult[];
  try {
    results = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Searching for ${truncate(label, 50)}`,
        cancellable: false,
      },
      () => client.search({ query, topK }),
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Semantic search failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (results.length === 0) {
    vscode.window.showInformationMessage(`No matching code found for ${truncate(label, 50)}.`);
    return;
  }
  showResults(results, label);
}

interface ResultItem extends vscode.QuickPickItem {
  result: SearchResult;
}

function showResults(results: SearchResult[], label: string): void {
  const items: ResultItem[] = results.map((r) => {
    const name = r.file.split(/[\\/]/).pop() ?? r.file;
    return {
      label: r.symbol ? `$(symbol-method) ${r.symbol}` : `$(file-code) ${name}`,
      description: `score ${r.score.toFixed(3)}`,
      detail: `${vscode.workspace.asRelativePath(r.file)}:${r.startLine}`,
      result: r,
    };
  });

  const qp = vscode.window.createQuickPick<ResultItem>();
  const count = `${results.length} result${results.length === 1 ? '' : 's'}`;
  qp.title = `Results for ${truncate(label, 45)} — ${count}`;
  qp.placeholder = 'Type to filter these results, or select one to jump to it';
  qp.items = items;
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  // Preview the focused result as the user arrows through, without stealing
  // focus from the list.
  qp.onDidChangeActive((active) => {
    if (active[0]) void reveal(active[0].result, true);
  });
  qp.onDidAccept(() => {
    const chosen = qp.selectedItems[0] ?? qp.activeItems[0];
    if (chosen) void reveal(chosen.result, false);
    qp.hide();
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

async function reveal(r: SearchResult, preview: boolean): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(r.file));
    const start = new vscode.Position(Math.max(0, r.startLine - 1), 0);
    const end = new vscode.Position(Math.max(0, r.endLine - 1), 0);
    const editor = await vscode.window.showTextDocument(doc, {
      preview,
      preserveFocus: preview,
      selection: new vscode.Range(start, start),
    });
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not open ${r.file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
