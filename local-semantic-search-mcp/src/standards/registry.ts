import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  type DetectContext,
  type DetectedStandard,
  type StandardReader,
  emptyStandard,
} from './types.js';
import { READERS } from './readers/index.js';

const MAX_READ_BYTES = 4 * 1024 * 1024; // don't slurp a giant generated file
const WALK_SKIP = new Set(['.git', 'node_modules', '.swe-search', 'vendor']);

// Bounded, read-only helpers for readers. `vendor/` is skipped by the generic walk
// (readers that need it, like the Composer reader, address it by explicit path).
function makeContext(workspaceRoot: string): DetectContext {
  const readText = (rel: string): string | null => {
    try {
      const abs = join(workspaceRoot, rel);
      if (statSync(abs).size > MAX_READ_BYTES) return null;
      return readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  };
  return {
    workspaceRoot,
    readText,
    readJson<T = unknown>(rel: string): T | null {
      const raw = readText(rel);
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    exists(rel: string): boolean {
      return existsSync(join(workspaceRoot, rel));
    },
    glob(suffix: string, cap: number): string[] {
      const out: string[] = [];
      const walk = (absDir: string): void => {
        if (out.length >= cap) return;
        let entries;
        try {
          entries = readdirSync(absDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (out.length >= cap) return;
          if (e.isDirectory()) {
            if (WALK_SKIP.has(e.name) || e.name.startsWith('.')) continue;
            walk(join(absDir, e.name));
          } else if (e.isFile() && e.name.endsWith(suffix)) {
            out.push(relative(workspaceRoot, join(absDir, e.name)).split(sep).join('/'));
          }
        }
      };
      walk(workspaceRoot);
      return out;
    },
  };
}

function merge(into: DetectedStandard, part: Partial<DetectedStandard> | null): void {
  if (!part) return;
  for (const f of part.frameworks ?? []) if (!into.frameworks.includes(f)) into.frameworks.push(f);
  for (const c of part.codingStandards ?? []) if (!into.codingStandards.includes(c)) into.codingStandards.push(c);
  for (const n of part.notes ?? []) if (!into.notes.includes(n)) into.notes.push(n);
  // PSR-4: first writer of a prefix wins (readers are ordered most-authoritative first).
  const seen = new Set(into.psr4.map((e) => e.prefix));
  for (const e of part.psr4 ?? []) {
    if (!seen.has(e.prefix)) {
      into.psr4.push(e);
      seen.add(e.prefix);
    }
  }
  const seenFqcn = new Set(into.classMap.map((e) => e.fqcn));
  for (const e of part.classMap ?? []) {
    if (!seenFqcn.has(e.fqcn)) {
      into.classMap.push(e);
      seenFqcn.add(e.fqcn);
    }
  }
}

const cache = new Map<string, DetectedStandard>();

// Run every reader (built-in + project) over the workspace and merge. Cached per
// process — standards artifacts (composer files, .foundry/standards.json) change
// rarely, and callers are read-mostly. Pass extraReaders in tests for pluggability.
export function detectStandards(workspaceRoot: string, extraReaders: StandardReader[] = []): DetectedStandard {
  if (extraReaders.length === 0 && cache.has(workspaceRoot)) return cache.get(workspaceRoot)!;

  const ctx = makeContext(workspaceRoot);
  const result = emptyStandard();
  for (const reader of [...READERS, ...extraReaders]) {
    try {
      merge(result, reader.read(ctx));
    } catch {
      /* a broken reader must never take down detection */
    }
  }
  // Longest prefix first so resolution can match greedily.
  result.psr4.sort((a, b) => b.prefix.length - a.prefix.length);

  if (extraReaders.length === 0) cache.set(workspaceRoot, result);
  return result;
}

export function clearStandardsCache(): void {
  cache.clear();
}
