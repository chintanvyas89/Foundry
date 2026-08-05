import type { ConfigSummarizer, ConfigItem, SummarizeContext } from '../../types.js';
import type { YamlValue } from '../../yaml.js';
import { asRecord, scalarStr, idFromFileName, collectDeps, facts, listPreview } from '../../util.js';

// Drupal Views — `config/sync/views.view.<name>.yml`. Summarizes the base table,
// the display list, and (from the default display) the fields/filters/sorts so a
// query like "which view lists published articles" can hit it.
export const drupalViewSummarizer: ConfigSummarizer = {
  id: 'drupal-view',
  match(relPath: string): boolean {
    const name = relPath.split('/').pop() ?? '';
    return /^views\.view\..+\.ya?ml$/i.test(name);
  },
  summarize(doc: YamlValue, ctx: SummarizeContext): ConfigItem[] | null {
    const rec = asRecord(doc);
    if (!rec) return null;
    const id = scalarStr(rec['id']) ?? idFromFileName(ctx.fileName);
    const label = scalarStr(rec['label']);
    const baseTable = scalarStr(rec['base_table']);
    const baseField = scalarStr(rec['base_field']);

    const displays = asRecord(rec['display']);
    const displayNames = displays ? Object.keys(displays) : [];

    // Pull fields / filters / sorts from the default display when present.
    const def = displays ? asRecord(displays['default']) : null;
    const opts = def ? asRecord(def['display_options']) : null;
    const fieldNames = opts ? Object.keys(asRecord(opts['fields']) ?? {}) : [];
    const filterNames = opts ? Object.keys(asRecord(opts['filters']) ?? {}) : [];
    const sortNames = opts ? Object.keys(asRecord(opts['sorts']) ?? {}) : [];
    const access = opts ? asRecord(opts['access']) : null;
    const accessType = access ? scalarStr(access['type']) : undefined;

    const deps = collectDeps(rec);
    const summary = facts(
      `Drupal View '${id}'${label ? ` (${label})` : ''}`,
      baseTable ? `base table ${baseTable}${baseField ? `/${baseField}` : ''}` : undefined,
      displayNames.length ? `displays: ${listPreview(displayNames)}` : undefined,
      fieldNames.length ? `fields: ${listPreview(fieldNames)}` : undefined,
      filterNames.length ? `filters: ${listPreview(filterNames)}` : undefined,
      sortNames.length ? `sorts: ${listPreview(sortNames)}` : undefined,
      accessType ? `access: ${accessType}` : undefined,
      deps ? `depends on ${deps}` : undefined,
    );

    return [{ id, type: 'view', label, deps, facts: summary, startLine: 1 }];
  },
};
