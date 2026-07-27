import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import type { Ignore } from 'ignore';

export type { Ignore };

// `ignore` is a CommonJS package (`module.exports = ignore`), but its .d.ts
// is written with ESM `export default` syntax. Under NodeNext, TS resolves
// the .d.ts itself as CommonJS (the package has no "type": "module"), so
// esModuleInterop can't synthesize a default import and a plain
// `import ignoreFactory from 'ignore'` fails with "not callable". Loading
// via require and casting to the declared default type sidesteps the
// mismatch and matches the package's actual runtime shape.
const require = createRequire(import.meta.url);
const ignoreFactory = require('ignore') as typeof import('ignore').default;

const IGNORE_FILES = ['.gitignore', '.sweignore'];

// Always excluded regardless of ignore files. Beyond the obvious VCS/dep
// dirs, this skips generated/lock files that are large, machine-written, and
// useless to search semantically — embedding a 4k-line package-lock.json is
// pure wasted CPU (and the embedding model is the slow part of indexing).
const DEFAULT_PATTERNS = [
  '.git',
  'node_modules',
  '.swe-search',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  '*.min.js',
  '*.min.css',
  '*.map',
];

export function buildIgnoreMatcher(workspaceRoot: string): Ignore {
  const ig = ignoreFactory().add(DEFAULT_PATTERNS);
  for (const filename of IGNORE_FILES) {
    const path = join(workspaceRoot, filename);
    if (existsSync(path)) {
      ig.add(readFileSync(path, 'utf-8'));
    }
  }
  return ig;
}

export function isIgnored(ig: Ignore, workspaceRoot: string, absPath: string): boolean {
  const rel = relative(workspaceRoot, absPath).split(sep).join('/');
  if (!rel || rel.startsWith('..')) return false;
  return ig.ignores(rel);
}
