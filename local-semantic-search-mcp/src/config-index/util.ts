import type { YamlValue } from './yaml.js';

// Shared helpers for the config summarizers. All are defensive: given unexpected
// shapes they return undefined/empty rather than throwing, so one malformed file
// can't break the config build.

export function asRecord(v: YamlValue | undefined): Record<string, YamlValue> | null {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, YamlValue>)
    : null;
}

export function asArray(v: YamlValue | undefined): YamlValue[] {
  return Array.isArray(v) ? v : [];
}

export function scalarStr(v: YamlValue | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'object') return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

// The config id is the filename without its (single) structured extension — for
// Drupal that IS the config id (`views.view.frontpage.yml` →
// `views.view.frontpage`); for other formats it's just the base name
// (`tsconfig.json` → `tsconfig`). Only the final extension is stripped, so dotted
// ids are preserved.
export function idFromFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

// A compact rendering of a Drupal config item's `dependencies:` block, e.g.
// "module: node, views; config: field.field.node.article.body".
export function collectDeps(rec: Record<string, YamlValue> | null): string | undefined {
  if (!rec) return undefined;
  const deps = asRecord(rec['dependencies']);
  if (!deps) return undefined;
  const parts: string[] = [];
  for (const key of ['module', 'theme', 'config', 'content']) {
    const list = asArray(deps[key]).map((x) => scalarStr(x)).filter(Boolean);
    if (list.length) parts.push(`${key}: ${list.join(', ')}`);
  }
  const enforced = asRecord(deps['enforced']);
  if (enforced) {
    for (const [k, v] of Object.entries(enforced)) {
      const list = asArray(v).map((x) => scalarStr(x)).filter(Boolean);
      if (list.length) parts.push(`enforced.${k}: ${list.join(', ')}`);
    }
  }
  return parts.length ? parts.join('; ') : undefined;
}

// Join the parts of a facts sentence, dropping empties, into one line.
export function facts(...parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => !!p && p.trim() !== '').join('. ');
}

// A short, bounded preview of a list of keys/values for the facts string.
export function listPreview(items: Array<string | undefined>, cap = 12): string | undefined {
  const clean = items.filter((x): x is string => !!x);
  if (clean.length === 0) return undefined;
  if (clean.length <= cap) return clean.join(', ');
  return `${clean.slice(0, cap).join(', ')} (+${clean.length - cap} more)`;
}
