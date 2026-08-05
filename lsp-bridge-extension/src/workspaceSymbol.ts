import * as vscode from 'vscode';

// One workspace-symbol hit from the language server. `file` absolute, `line` 1-based,
// `container` is the enclosing namespace/class (used to disambiguate a FQCN).
export interface WsSymbolNode {
  name: string;
  kind: string;
  container: string;
  file: string;
  line: number;
}

// Resolve a symbol NAME to its location(s) via the language server's workspace symbol
// provider. This reuses the server's own PSR-4/namespace/autoload knowledge (e.g.
// Intelephense for PHP) — so a class name maps to its file the same way the editor's
// "Go to Symbol in Workspace" does. Empty when no provider/match.
export async function resolveWorkspaceSymbol(query: string, cap = 40): Promise<WsSymbolNode[]> {
  const raw = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider',
    query,
  );
  if (!raw || raw.length === 0) return [];

  const out: WsSymbolNode[] = [];
  for (const s of raw) {
    out.push({
      name: s.name,
      kind: vscode.SymbolKind[s.kind] ?? String(s.kind),
      container: s.containerName ?? '',
      file: s.location.uri.fsPath,
      line: s.location.range.start.line + 1,
    });
    if (out.length >= cap) break;
  }
  return out;
}
