import type { ConfigSummarizer, ConfigItem, SummarizeContext } from '../../types.js';
import type { YamlValue } from '../../yaml.js';
import { asRecord, scalarStr, facts } from '../../util.js';

// Drupal routes — `<module>.routing.yml`. Each top-level key is a route name.
// Emits one item per route with its path, controller/form/title and access
// requirements, so "what handles the /market/activity path" is findable.
export const drupalRoutingSummarizer: ConfigSummarizer = {
  id: 'drupal-routing',
  match(relPath: string): boolean {
    const name = relPath.split('/').pop() ?? '';
    return /\.routing\.ya?ml$/i.test(name);
  },
  summarize(doc: YamlValue, _ctx: SummarizeContext): ConfigItem[] | null {
    const rec = asRecord(doc);
    if (!rec) return null;
    const items: ConfigItem[] = [];
    for (const [routeName, def] of Object.entries(rec)) {
      const d = asRecord(def);
      if (!d) continue;
      const path = scalarStr(d['path']);
      const defaults = asRecord(d['defaults']);
      const controller = defaults
        ? scalarStr(defaults['_controller']) ??
          scalarStr(defaults['_form']) ??
          scalarStr(defaults['_entity_form'])
        : undefined;
      const title = defaults ? scalarStr(defaults['_title']) : undefined;
      const req = asRecord(d['requirements']);
      const access = req
        ? scalarStr(req['_permission']) ??
          scalarStr(req['_role']) ??
          scalarStr(req['_access']) ??
          scalarStr(req['_entity_access'])
        : undefined;

      // Skip stray top-level keys that aren't routes (no path & no defaults).
      if (!path && !defaults) continue;

      const summary = facts(
        `Drupal route '${routeName}'`,
        path ? `path ${path}` : undefined,
        controller ? `handler ${controller}` : undefined,
        title ? `title '${title}'` : undefined,
        access ? `access ${access}` : undefined,
      );
      items.push({ id: routeName, type: 'route', label: title, facts: summary, startLine: 1 });
    }
    return items.length ? items : null;
  },
};
