import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
type Language = Parser.Language;
type SyntaxNode = Parser.SyntaxNode;
import type { Chunk } from '../types.js';

const require = createRequire(import.meta.url);

// Node types worth chunking on, per grammar — matches the granularity of
// CHUNK_SYMBOL_KINDS in chunker.ts (Function, Method, Class, Constructor).
//
// wasm paths are flat — `tree-sitter-wasms/out/tree-sitter-<lang>.wasm` —
// not nested under a per-grammar directory as originally drafted. Verified
// against the files actually shipped by the installed tree-sitter-wasms
// package (0.1.x): `out/tree-sitter-typescript.wasm`, `out/tree-sitter-tsx.wasm`,
// etc., all directly under `out/`.
const LANGUAGES: Record<string, { wasm: string; symbolNodeTypes: string[] }> = {
  '.ts': {
    wasm: 'tree-sitter-typescript.wasm',
    symbolNodeTypes: ['function_declaration', 'method_definition', 'class_declaration'],
  },
  '.tsx': {
    wasm: 'tree-sitter-tsx.wasm',
    symbolNodeTypes: ['function_declaration', 'method_definition', 'class_declaration'],
  },
  '.js': {
    wasm: 'tree-sitter-javascript.wasm',
    symbolNodeTypes: ['function_declaration', 'method_definition', 'class_declaration'],
  },
  '.jsx': {
    wasm: 'tree-sitter-javascript.wasm',
    symbolNodeTypes: ['function_declaration', 'method_definition', 'class_declaration'],
  },
  '.py': {
    wasm: 'tree-sitter-python.wasm',
    symbolNodeTypes: ['function_definition', 'class_definition'],
  },
  '.go': {
    wasm: 'tree-sitter-go.wasm',
    symbolNodeTypes: ['function_declaration', 'method_declaration'],
  },
  '.rs': {
    wasm: 'tree-sitter-rust.wasm',
    symbolNodeTypes: ['function_item', 'impl_item'],
  },
  '.java': {
    wasm: 'tree-sitter-java.wasm',
    symbolNodeTypes: ['method_declaration', 'class_declaration', 'constructor_declaration'],
  },
  '.c': {
    wasm: 'tree-sitter-c.wasm',
    symbolNodeTypes: ['function_definition'],
  },
  '.cpp': {
    wasm: 'tree-sitter-cpp.wasm',
    symbolNodeTypes: ['function_definition'],
  },
  ...phpExtensions(),
};

// PHP — including Drupal's non-`.php` source extensions (`.module`, `.inc`,
// `.install`, `.theme`, `.profile`, `.engine`), which are all plain PHP. The full
// PHP grammar handles the leading `<?php` tag and mixed-HTML templates; a file
// that uses one of these extensions but isn't PHP simply yields no symbol nodes
// and falls through to fixed-window chunking, so the mapping is safe.
//
// Top-level `function_definition` captures Drupal hooks (e.g. `mymodule_form_alter`)
// as their own named chunks; `class_declaration` captures classes like Drupal
// route providers as one named chunk, which makes them findable by `search_symbol`
// offline — the gap that left PHP files effectively unsearchable before.
function phpExtensions(): Record<string, { wasm: string; symbolNodeTypes: string[] }> {
  const php = {
    wasm: 'tree-sitter-php.wasm',
    symbolNodeTypes: [
      'function_definition',
      'method_declaration',
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
      'enum_declaration',
    ],
  };
  const exts = ['.php', '.module', '.inc', '.install', '.theme', '.profile', '.engine'];
  return Object.fromEntries(exts.map((e) => [e, php]));
}

let initialized: Promise<void> | null = null;
const loadedLanguages = new Map<string, Language>();

async function ensureInitialized(): Promise<void> {
  if (!initialized) {
    initialized = Parser.init();
  }
  await initialized;
}

async function getLanguage(ext: string): Promise<Language> {
  const cached = loadedLanguages.get(ext);
  if (cached) return cached;

  const entry = LANGUAGES[ext];
  const wasmPath = require.resolve(`tree-sitter-wasms/out/${entry.wasm}`);
  const language = await Parser.Language.load(wasmPath);
  loadedLanguages.set(ext, language);
  return language;
}

export function supportsTreeSitter(ext: string): boolean {
  return ext in LANGUAGES;
}

export async function chunkWithTreeSitter(filePath: string, ext: string): Promise<Chunk[]> {
  const entry = LANGUAGES[ext];
  if (!entry) return [];

  await ensureInitialized();
  const language = await getLanguage(ext);

  const parser = new Parser();
  parser.setLanguage(language);

  const source = readFileSync(filePath, 'utf-8');
  const tree = parser.parse(source);
  if (!tree) return [];

  const chunks: Chunk[] = [];
  const symbolTypes = new Set(entry.symbolNodeTypes);

  const visit = (node: SyntaxNode) => {
    if (symbolTypes.has(node.type)) {
      const text = node.text;
      if (text.trim()) {
        chunks.push({
          file: filePath,
          symbol: symbolName(node),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          text,
          contentHash: createHash('sha1').update(text).digest('hex'),
        });
      }
      // Don't descend into a matched node's children — keeps chunk
      // granularity consistent with the LSP-bridge tier, which also
      // stops at the top-level symbol.
      return;
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child);
    }
  };

  visit(tree.rootNode);
  return chunks;
}

function symbolName(node: SyntaxNode): string | undefined {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text;
}
