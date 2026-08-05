import type { ConfigSummarizer, ConfigItem, SummarizeContext } from '../types.js';
import type { YamlValue } from '../yaml.js';
import { asRecord, scalarStr, idFromFileName, collectDeps, facts, listPreview } from '../util.js';

// A neutral, format-agnostic type for grouping/filtering: the first dotted
// segment of the id (Drupal's `views.view.frontpage` → `views`, a plain
// `database.settings` → `database`), else `config`. Type-specific packs override
// this with precise types (view, field, service, …) when enabled.
function coarseType(id: string): string {
  return id.split('.')[0] || 'config';
}

// The catch-all: works for ANY structured file (YAML or JSON object/array, or an
// unparseable file — then it degrades to a filename-based item). Emits one item
// per file with whatever identifying/structural facts are present. Must be LAST.
export const genericSummarizer: ConfigSummarizer = {
  id: 'generic',
  match(): boolean {
    return true;
  },
  summarize(doc: YamlValue, ctx: SummarizeContext): ConfigItem[] {
    const rec = asRecord(doc);
    const id = scalarStr(rec?.['id']) ?? idFromFileName(ctx.fileName);
    const label = scalarStr(rec?.['label']) ?? scalarStr(rec?.['name']);
    const type = coarseType(id);
    const deps = collectDeps(rec);

    const topKeys = rec ? Object.keys(rec) : [];
    const status = rec && 'status' in rec ? (rec['status'] ? 'enabled' : 'disabled') : undefined;
    const langcode = scalarStr(rec?.['langcode']);

    const summary = facts(
      `Config '${id}'${label ? ` (${label})` : ''}`,
      status ? `status: ${status}` : undefined,
      langcode ? `langcode: ${langcode}` : undefined,
      topKeys.length ? `keys: ${listPreview(topKeys)}` : undefined,
      deps ? `depends on ${deps}` : undefined,
      `file ${ctx.relPath}`,
    );

    return [{ id, type, label, deps, facts: summary, startLine: 1 }];
  },
};
