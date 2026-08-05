import type { ConfigSummarizer, ConfigItem, SummarizeContext } from '../../types.js';
import type { YamlValue } from '../../yaml.js';
import { asRecord, scalarStr, idFromFileName, collectDeps, facts, listPreview } from '../../util.js';

// Drupal entity form/view displays —
// `core.entity_form_display.<entity>.<bundle>.<mode>` and
// `core.entity_view_display.<entity>.<bundle>.<mode>`. Summarizes which fields
// are placed and in what mode, so "how is the Article node form laid out" hits.
export const drupalDisplaySummarizer: ConfigSummarizer = {
  id: 'drupal-display',
  match(relPath: string): boolean {
    const name = relPath.split('/').pop() ?? '';
    return /^core\.entity_(form|view)_display\..+\.ya?ml$/i.test(name);
  },
  summarize(doc: YamlValue, ctx: SummarizeContext): ConfigItem[] | null {
    const rec = asRecord(doc);
    if (!rec) return null;
    const id = scalarStr(rec['id']) ?? idFromFileName(ctx.fileName);
    const isForm = /^core\.entity_form_display\./.test(ctx.fileName);
    const type = isForm ? 'entity_form_display' : 'entity_view_display';

    const targetEntity = scalarStr(rec['targetEntityType']);
    const bundle = scalarStr(rec['bundle']);
    const mode = scalarStr(rec['mode']);
    const components = Object.keys(asRecord(rec['content']) ?? {});
    const hidden = Object.keys(asRecord(rec['hidden']) ?? {});

    const deps = collectDeps(rec);
    const summary = facts(
      `Drupal ${isForm ? 'form' : 'view'} display '${id}'`,
      targetEntity ? `for ${targetEntity}${bundle ? `/${bundle}` : ''}` : undefined,
      mode ? `mode ${mode}` : undefined,
      components.length ? `shows: ${listPreview(components)}` : undefined,
      hidden.length ? `hidden: ${listPreview(hidden)}` : undefined,
      deps ? `depends on ${deps}` : undefined,
    );

    return [{ id, type, label: undefined, deps, facts: summary, startLine: 1 }];
  },
};
