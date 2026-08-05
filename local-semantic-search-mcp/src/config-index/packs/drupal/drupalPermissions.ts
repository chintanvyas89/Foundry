import type { ConfigSummarizer, ConfigItem, SummarizeContext } from '../../types.js';
import type { YamlValue } from '../../yaml.js';
import { asRecord, scalarStr, facts } from '../../util.js';

// Drupal permissions — `<module>.permissions.yml`. Each top-level key is a
// permission machine name (value = map with title/description/restrict access).
// Dynamic permissions declared via `permission_callbacks` are noted as one item.
export const drupalPermissionsSummarizer: ConfigSummarizer = {
  id: 'drupal-permissions',
  match(relPath: string): boolean {
    const name = relPath.split('/').pop() ?? '';
    return /\.permissions\.ya?ml$/i.test(name);
  },
  summarize(doc: YamlValue, ctx: SummarizeContext): ConfigItem[] | null {
    const rec = asRecord(doc);
    if (!rec) return null;
    const items: ConfigItem[] = [];
    for (const [name, def] of Object.entries(rec)) {
      if (name === 'permission_callbacks') {
        const module = ctx.fileName.replace(/\.permissions\.ya?ml$/i, '');
        items.push({
          id: `${module}:dynamic_permissions`,
          type: 'permission',
          facts: facts(
            `Drupal dynamic permissions for module '${module}'`,
            'declared via permission_callbacks',
          ),
          startLine: 1,
        });
        continue;
      }
      const d = asRecord(def);
      const title = d ? scalarStr(d['title']) : scalarStr(def);
      const description = d ? scalarStr(d['description']) : undefined;
      const restrict = d && d['restrict access'] === true ? 'restricted access' : undefined;
      const summary = facts(
        `Drupal permission '${name}'`,
        title ? `title '${title}'` : undefined,
        description ? `— ${description}` : undefined,
        restrict,
      );
      items.push({ id: name, type: 'permission', label: title, facts: summary, startLine: 1 });
    }
    return items.length ? items : null;
  },
};
