import type { ConfigSummarizer, ConfigItem, SummarizeContext } from '../../types.js';
import type { YamlValue } from '../../yaml.js';
import { asRecord, scalarStr, idFromFileName, collectDeps, facts } from '../../util.js';

// Drupal fields — both the per-bundle instance (`field.field.<entity>.<bundle>.<field>`)
// and the storage definition (`field.storage.<entity>.<field>`). Summarizes the
// entity/bundle it attaches to, the field type, and required/label so "what
// fields does the Article content type have" is answerable.
export const drupalFieldSummarizer: ConfigSummarizer = {
  id: 'drupal-field',
  match(relPath: string): boolean {
    const name = relPath.split('/').pop() ?? '';
    return /^field\.(field|storage)\..+\.ya?ml$/i.test(name);
  },
  summarize(doc: YamlValue, ctx: SummarizeContext): ConfigItem[] | null {
    const rec = asRecord(doc);
    if (!rec) return null;
    const id = scalarStr(rec['id']) ?? idFromFileName(ctx.fileName);
    const isStorage = /^field\.storage\./.test(ctx.fileName);
    const type = isStorage ? 'field_storage' : 'field';

    const label = scalarStr(rec['label']);
    const fieldName = scalarStr(rec['field_name']);
    const entityType = scalarStr(rec['entity_type']);
    const bundle = scalarStr(rec['bundle']);
    const fieldType = scalarStr(rec['type']) ?? scalarStr(rec['field_type']);
    const required = rec['required'] === true ? 'required' : undefined;
    const cardinality = scalarStr(rec['cardinality']);

    const deps = collectDeps(rec);
    const summary = facts(
      `Drupal ${isStorage ? 'field storage' : 'field'} '${id}'${label ? ` (${label})` : ''}`,
      fieldName ? `field ${fieldName}` : undefined,
      entityType ? `on ${entityType}${bundle ? `/${bundle}` : ''}` : undefined,
      fieldType ? `type ${fieldType}` : undefined,
      required,
      cardinality ? `cardinality ${cardinality}` : undefined,
      deps ? `depends on ${deps}` : undefined,
    );

    return [{ id, type, label, deps, facts: summary, startLine: 1 }];
  },
};
