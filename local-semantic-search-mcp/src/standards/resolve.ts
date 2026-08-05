import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectedStandard } from './types.js';

// Resolve a fully-qualified class name to a workspace file using the detected
// standards — an exact Composer classmap hit first, else the longest-matching PSR-4
// prefix mapped to a subdirectory. Verifies the file exists so a wrong guess returns
// null rather than a bogus path.
export function resolveFqcn(
  fqcn: string,
  standards: DetectedStandard,
  workspaceRoot: string,
): { rel: string; abs: string } | null {
  const clean = fqcn.replace(/^\\+/, '').trim();
  if (!clean) return null;

  // 1) exact classmap (authoritative when the optimized autoloader was generated)
  const exact = standards.classMap.find((e) => e.fqcn === clean);
  if (exact && existsSync(join(workspaceRoot, exact.file))) {
    return { rel: exact.file, abs: join(workspaceRoot, exact.file) };
  }

  // 2) longest-prefix PSR-4 (psr4 is pre-sorted longest-first by the registry)
  for (const entry of standards.psr4) {
    if (clean.startsWith(entry.prefix)) {
      const sub = clean.slice(entry.prefix.length).replace(/\\/g, '/');
      const rel = `${entry.dir}/${sub}.php`.replace(/\/+/g, '/');
      if (existsSync(join(workspaceRoot, rel))) return { rel, abs: join(workspaceRoot, rel) };
    }
  }
  return null;
}

// "Is this a fully-qualified class name?" — backslash-separated identifier segments
// with no path separators or extensions (so a Windows path like `src\a.ts` or
// `a\b\c.php` is NOT treated as an FQCN). Used to route a read_file `file` arg
// through class resolution instead of treating it as a path.
export function looksLikeFqcn(s: string): boolean {
  return /^\\?[A-Za-z_][A-Za-z0-9_]*(\\[A-Za-z_][A-Za-z0-9_]*)+$/.test(s.trim());
}
