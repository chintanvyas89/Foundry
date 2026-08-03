import * as vscode from 'vscode';
import { positionOf } from './callHierarchy';

// One usage/implementation location. `file` is absolute, `line` is 1-based,
// `text` is the trimmed source line for context.
export interface RefNode {
  file: string;
  line: number;
  text: string;
}

// All references to the symbol at (file, line) — where it's used across the
// workspace (calls, imports, type references). Empty when no reference provider
// is available. Shared by the panel (direct) and the MCP server (bridge pipe).
export async function getReferences(
  file: string,
  line: number,
  symbol?: string,
): Promise<RefNode[]> {
  return locations('vscode.executeReferenceProvider', file, line, symbol);
}

// Concrete implementations of an interface/abstract symbol at (file, line).
export async function getImplementations(
  file: string,
  line: number,
  symbol?: string,
): Promise<RefNode[]> {
  return locations('vscode.executeImplementationProvider', file, line, symbol);
}

async function locations(
  command: string,
  file: string,
  line: number,
  symbol: string | undefined,
  cap = 60,
): Promise<RefNode[]> {
  const uri = vscode.Uri.file(file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const raw = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
    command,
    uri,
    positionOf(doc, line, symbol),
  );
  if (!raw || raw.length === 0) return [];

  const seen = new Set<string>();
  const out: RefNode[] = [];
  for (const loc of raw) {
    const targetUri = 'uri' in loc ? loc.uri : loc.targetUri;
    const range = 'range' in loc ? loc.range : loc.targetRange;
    const lineIdx = range.start.line;
    const key = `${targetUri.fsPath}:${lineIdx}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let text = '';
    try {
      const d = await vscode.workspace.openTextDocument(targetUri);
      text = d.lineAt(lineIdx).text.trim();
    } catch {
      /* referenced file unreadable — still list the location */
    }
    out.push({ file: targetUri.fsPath, line: lineIdx + 1, text });
    if (out.length >= cap) break;
  }
  return out;
}
