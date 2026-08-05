import type { ConfigSummarizer, ConfigItem, SummarizeContext } from '../../types.js';
import type { YamlValue } from '../../yaml.js';
import { asRecord, asArray, scalarStr, facts, listPreview } from '../../util.js';

// Drupal service container definitions — `<module>.services.yml`. Emits ONE item
// per service (id = the service name, e.g. `market.route_subscriber`) with its
// class and tags, so "where is the X service defined / what tags it" is findable.
export const drupalServicesSummarizer: ConfigSummarizer = {
  id: 'drupal-services',
  match(relPath: string): boolean {
    const name = relPath.split('/').pop() ?? '';
    return /\.services\.ya?ml$/i.test(name);
  },
  summarize(doc: YamlValue, _ctx: SummarizeContext): ConfigItem[] | null {
    const rec = asRecord(doc);
    const services = asRecord(rec?.['services']);
    if (!services) return null;
    const items: ConfigItem[] = [];
    for (const [name, def] of Object.entries(services)) {
      const d = asRecord(def);
      const cls = d ? scalarStr(d['class']) : undefined;
      const parent = d ? scalarStr(d['parent']) : undefined;
      const tags = d
        ? asArray(d['tags'])
            .map((t) => scalarStr(asRecord(t)?.['name']))
            .filter(Boolean)
        : [];
      const argCount = d ? asArray(d['arguments']).length : 0;
      const summary = facts(
        `Drupal service '${name}'`,
        cls ? `class ${cls}` : undefined,
        parent ? `parent ${parent}` : undefined,
        argCount ? `${argCount} argument(s)` : undefined,
        tags.length ? `tags: ${listPreview(tags)}` : undefined,
      );
      items.push({ id: name, type: 'service', label: cls, facts: summary, startLine: 1 });
    }
    return items.length ? items : null;
  },
};
