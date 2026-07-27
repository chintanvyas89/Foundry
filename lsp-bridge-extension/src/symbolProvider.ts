import * as vscode from 'vscode';

export interface BridgeSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

// Matches the granularity the MCP server's tree-sitter fallback uses —
// keep these in sync if that set changes.
const RELEVANT_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Constructor,
]);

export async function getSymbolsForFile(filePath: string): Promise<BridgeSymbol[]> {
  const uri = vscode.Uri.file(filePath);
  // Ensures VS Code knows the document and its language ID before asking a
  // provider for symbols — matters for files not already open in an editor.
  await vscode.workspace.openTextDocument(uri);

  const result = await vscode.commands.executeCommand<
    vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined
  >('vscode.executeDocumentSymbolProvider', uri);

  if (!result || result.length === 0) return [];

  // Modern providers return hierarchical DocumentSymbol[]; some older ones
  // return flat SymbolInformation[]. Handle both.
  if (isDocumentSymbolArray(result)) {
    return flattenTopLevel(result);
  }
  return result
    .filter((s) => RELEVANT_KINDS.has(s.kind))
    .map((s) => ({
      name: s.name,
      kind: vscode.SymbolKind[s.kind],
      startLine: s.location.range.start.line + 1,
      endLine: s.location.range.end.line + 1,
    }));
}

function isDocumentSymbolArray(
  arr: vscode.DocumentSymbol[] | vscode.SymbolInformation[],
): arr is vscode.DocumentSymbol[] {
  return 'range' in arr[0];
}

function flattenTopLevel(symbols: vscode.DocumentSymbol[]): BridgeSymbol[] {
  const out: BridgeSymbol[] = [];
  for (const sym of symbols) {
    if (RELEVANT_KINDS.has(sym.kind)) {
      out.push({
        name: sym.name,
        kind: vscode.SymbolKind[sym.kind],
        startLine: sym.range.start.line + 1,
        endLine: sym.range.end.line + 1,
      });
      // Don't descend into a matched symbol's children — mirrors the
      // self-contained-chunk choice made in the MCP server's tree-sitter
      // chunker, so chunk granularity is consistent regardless of source.
      continue;
    }
    if (sym.children?.length) {
      out.push(...flattenTopLevel(sym.children));
    }
  }
  return out;
}
