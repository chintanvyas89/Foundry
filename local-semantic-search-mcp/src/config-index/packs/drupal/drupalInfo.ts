import type { ConfigSummarizer, ConfigItem, SummarizeContext } from '../../types.js';
import type { YamlValue } from '../../yaml.js';
import { asRecord, asArray, scalarStr, facts, listPreview } from '../../util.js';

// Drupal extension manifests — `<machine_name>.info.yml` for a module, theme or
// profile. id = the machine name; type reflects the declared `type:`. Summarizes
// name/description/package/dependencies/core requirement so "what is the market
// module / what does it depend on" is answerable.
export const drupalInfoSummarizer: ConfigSummarizer = {
  id: 'drupal-info',
  match(relPath: string): boolean {
    const name = relPath.split('/').pop() ?? '';
    return /\.info\.ya?ml$/i.test(name);
  },
  summarize(doc: YamlValue, ctx: SummarizeContext): ConfigItem[] | null {
    const rec = asRecord(doc);
    if (!rec) return null;
    const machine = ctx.fileName.replace(/\.info\.ya?ml$/i, '');
    const declaredType = scalarStr(rec['type']); // module | theme | profile
    const type = declaredType ? `${declaredType}_info` : 'extension_info';

    const name = scalarStr(rec['name']);
    const description = scalarStr(rec['description']);
    const pkg = scalarStr(rec['package']);
    const core = scalarStr(rec['core_version_requirement']) ?? scalarStr(rec['core']);
    const baseTheme = scalarStr(rec['base theme']);
    const deps = asArray(rec['dependencies']).map((d) => scalarStr(d)).filter(Boolean);

    const summary = facts(
      `Drupal ${declaredType ?? 'extension'} '${machine}'${name ? ` (${name})` : ''}`,
      description ? description : undefined,
      pkg ? `package ${pkg}` : undefined,
      baseTheme ? `base theme ${baseTheme}` : undefined,
      core ? `core ${core}` : undefined,
      deps.length ? `dependencies: ${listPreview(deps)}` : undefined,
    );

    return [
      {
        id: machine,
        type,
        label: name,
        deps: deps.length ? deps.join(', ') : undefined,
        facts: summary,
        startLine: 1,
      },
    ];
  },
};
