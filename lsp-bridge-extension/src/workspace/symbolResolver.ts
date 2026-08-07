import * as vscode from 'vscode';
import * as path from 'path';

// Resolve a symbol BY NAME to a concrete range in the CURRENT buffer, via
// `vscode.executeDocumentSymbolProvider` — the same mechanism VS Code's own
// "Go to Symbol" uses, so it works for any language with a language server and
// needs no re-index. This is the anchor for the symbol-anchored edit tools
// (replace_symbol / insert_near_symbol / rename_symbol): resolving fresh from
// the live document (never precomputed) means an earlier edit in the same run
// can't leave a stale range behind.

export interface SymbolTarget {
  file: string;
  symbol: string; // dotted path ok, e.g. "Widget.render"
  container?: string; // enclosing symbol name, when the plain name is ambiguous
  index?: number; // pick the Nth match (0-based) when several remain
  signature?: string; // substring of the declaration line to disambiguate overloads
}

export type SymbolResolutionKind = 'no_symbols' | 'symbol_not_found' | 'ambiguous_symbol';

export class SymbolResolutionError extends Error {
  constructor(
    public readonly kind: SymbolResolutionKind,
    message: string,
  ) {
    super(message);
    this.name = 'SymbolResolutionError';
  }
}

export interface ResolvedSymbol {
  document: vscode.TextDocument;
  name: string;
  // Whole declaration incl. body — the target for replace_symbol.
  fullRange: vscode.Range;
  // Just the name identifier — the anchor for insert_near_symbol and rename_symbol.
  selectionRange: vscode.Range;
}

interface Candidate {
  name: string;
  parentName?: string;
  path: string[]; // names from the document root down to this symbol
  fullRange: vscode.Range;
  selectionRange: vscode.Range;
}

export async function resolveSymbol(
  target: SymbolTarget,
  workspaceRoot: string,
): Promise<ResolvedSymbol> {
  const filePath = path.isAbsolute(target.file) ? target.file : path.join(workspaceRoot, target.file);
  const uri = vscode.Uri.file(filePath);
  const document = await vscode.workspace.openTextDocument(uri);

  const raw = await vscode.commands.executeCommand<
    vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined
  >('vscode.executeDocumentSymbolProvider', uri);

  if (!raw || raw.length === 0) {
    throw new SymbolResolutionError(
      'no_symbols',
      `No document symbols available for ${target.file} (no language provider, or the file is empty).`,
    );
  }

  const all = isDocumentSymbolArray(raw) ? flattenHierarchical(raw) : flattenFlat(raw);

  const segments = target.symbol.split('.').filter(Boolean);
  let candidates = all.filter((c) => matchesPath(c, segments));

  // Disambiguation, in the order most-specific first.
  if (target.container) {
    candidates = candidates.filter((c) => c.parentName === target.container);
  }
  if (target.signature) {
    candidates = candidates.filter((c) =>
      document.lineAt(c.selectionRange.start.line).text.includes(target.signature!),
    );
  }

  if (candidates.length === 0) {
    throw new SymbolResolutionError(
      'symbol_not_found',
      `Symbol "${target.symbol}" not found in ${target.file}` +
        (target.container ? ` (container "${target.container}")` : '') +
        (target.signature ? ` (signature contains "${target.signature}")` : ''),
    );
  }

  if (candidates.length > 1) {
    if (target.index === undefined) {
      const where = candidates.map((c) => `line ${c.selectionRange.start.line + 1}`).join(', ');
      throw new SymbolResolutionError(
        'ambiguous_symbol',
        `Symbol "${target.symbol}" is ambiguous in ${target.file} (${candidates.length} matches: ${where}). ` +
          `Add container/signature/index to disambiguate.`,
      );
    }
    // Deterministic order for indexing: by start position.
    candidates.sort((a, b) => a.selectionRange.start.compareTo(b.selectionRange.start));
  }

  const picked = target.index !== undefined ? candidates[target.index] : candidates[0];
  if (!picked) {
    throw new SymbolResolutionError(
      'symbol_not_found',
      `index ${target.index} is out of range for "${target.symbol}" in ${target.file} (${candidates.length} matches).`,
    );
  }

  return {
    document,
    name: picked.name,
    fullRange: picked.fullRange,
    selectionRange: picked.selectionRange,
  };
}

// A candidate matches the requested dotted path when the path's trailing segments
// equal the requested segments (so "CreateUser" matches "UserService.CreateUser",
// and the fully-qualified form matches too).
function matchesPath(c: Candidate, segments: string[]): boolean {
  if (segments.length === 0) return false;
  if (segments.length > c.path.length) return false;
  const tail = c.path.slice(c.path.length - segments.length);
  return tail.every((name, i) => name === segments[i]);
}

function isDocumentSymbolArray(
  arr: vscode.DocumentSymbol[] | vscode.SymbolInformation[],
): arr is vscode.DocumentSymbol[] {
  return arr.length > 0 && 'children' in arr[0] && 'selectionRange' in arr[0];
}

function flattenHierarchical(symbols: vscode.DocumentSymbol[]): Candidate[] {
  const out: Candidate[] = [];
  const walk = (syms: vscode.DocumentSymbol[], parentPath: string[]): void => {
    for (const sym of syms) {
      const path = [...parentPath, sym.name];
      out.push({
        name: sym.name,
        parentName: parentPath[parentPath.length - 1],
        path,
        fullRange: sym.range,
        selectionRange: sym.selectionRange,
      });
      if (sym.children?.length) walk(sym.children, path);
    }
  };
  walk(symbols, []);
  return out;
}

function flattenFlat(symbols: vscode.SymbolInformation[]): Candidate[] {
  return symbols.map((s) => ({
    name: s.name,
    parentName: s.containerName || undefined,
    // Flat providers give no hierarchy; approximate the path as container→name.
    path: s.containerName ? [s.containerName, s.name] : [s.name],
    fullRange: s.location.range,
    selectionRange: s.location.range,
  }));
}
