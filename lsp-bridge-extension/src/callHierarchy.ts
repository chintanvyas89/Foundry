import * as vscode from 'vscode';

// One call-graph node. `file` is an absolute path; `line` is 1-based.
export interface CallNode {
  name: string;
  detail: string;
  file: string;
  line: number;
  kind: string;
}

export interface CallHierarchyResult {
  root: CallNode | null;
  outgoing: CallNode[]; // functions the root calls (callees)
  incoming: CallNode[]; // functions that call the root (callers)
}

// Compute one level of call hierarchy for the symbol at (file, line) using the
// active language server. Returns empty root when no call-hierarchy provider is
// available (unsupported language, server not ready) — callers treat that as
// "unavailable" rather than an error. Shared by the panel (direct) and the MCP
// server (over the bridge pipe).
export async function getCallHierarchy(
  file: string,
  line: number,
  symbol?: string,
): Promise<CallHierarchyResult> {
  const item = await prepare(file, line, symbol);
  if (!item) return { root: null, outgoing: [], incoming: [] };

  const [out, inc] = await Promise.all([
    vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
      'vscode.provideOutgoingCalls',
      item,
    ),
    vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
      'vscode.provideIncomingCalls',
      item,
    ),
  ]);

  return {
    root: toNode(item),
    outgoing: dedupe((out ?? []).map((c) => toNode(c.to))),
    incoming: dedupe((inc ?? []).map((c) => toNode(c.from))),
  };
}

// A 1-based line, plus a symbol name, resolved to a precise position on that
// symbol's identifier — more reliable for LSP providers than the line start,
// which may sit on a keyword. Shared by call hierarchy and references.
export function positionOf(
  doc: vscode.TextDocument,
  line: number,
  symbol?: string,
): vscode.Position {
  const lineIdx = Math.min(Math.max(0, line - 1), doc.lineCount - 1);
  const textLine = doc.lineAt(lineIdx);
  let character = textLine.firstNonWhitespaceCharacterIndex;
  if (symbol) {
    const at = textLine.text.indexOf(symbol);
    if (at >= 0) character = at;
  }
  return new vscode.Position(lineIdx, character);
}

async function prepare(
  file: string,
  line: number,
  symbol?: string,
): Promise<vscode.CallHierarchyItem | undefined> {
  const uri = vscode.Uri.file(file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy',
    uri,
    positionOf(doc, line, symbol),
  );
  return items && items[0];
}

function toNode(item: vscode.CallHierarchyItem): CallNode {
  return {
    name: item.name,
    detail: item.detail ?? '',
    file: item.uri.fsPath,
    line: item.selectionRange.start.line + 1,
    kind: vscode.SymbolKind[item.kind] ?? '',
  };
}

function dedupe(nodes: CallNode[]): CallNode[] {
  const seen = new Set<string>();
  const out: CallNode[] = [];
  for (const n of nodes) {
    const key = `${n.file}:${n.line}:${n.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}
