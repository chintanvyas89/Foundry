import { parseYaml, type YamlValue } from './yaml.js';
import { CORE_SUMMARIZERS } from './summarizers/index.js';
import type { ConfigItem, ConfigSummarizer, SummarizeContext } from './types.js';
import { isConfigExtension } from './settings.js';

export type { ConfigItem, ConfigSummarizer } from './types.js';
export { isConfigExtension } from './settings.js';

// Whether a path is treated as structured config for THIS project — driven by the
// per-project extension set (see settings.ts / `.foundry/config.json`). Used by
// the indexer/chunker to keep config OUT of the vector store, and by the config
// builder to decide what to summarize.
export function isConfigFile(path: string): boolean {
  return isConfigExtension(path);
}

// Parse a structured-config file by extension. YAML + JSON are built in; any other
// declared extension returns null, and the generic summarizer degrades to a
// filename-based item. Adding a format = one more branch here (e.g. TOML/INI).
export function parseStructured(relPath: string, text: string): YamlValue {
  const dot = relPath.lastIndexOf('.');
  const ext = dot === -1 ? '' : relPath.slice(dot).toLowerCase();
  try {
    if (ext === '.yml' || ext === '.yaml') return parseYaml(text);
    if (ext === '.json') return JSON.parse(text) as YamlValue;
  } catch {
    return null;
  }
  return null;
}

export interface SummarizeOptions {
  // Project-contributed summarizers, tried first (highest precedence).
  extraSummarizers?: ConfigSummarizer[];
  // Enabled type-specific pack summarizers (e.g. Drupal), tried before the core.
  packSummarizers?: ConfigSummarizer[];
}

// Parse one config file and run it through the summarizer chain:
//   extra (project) → packs (enabled) → core (generic catch-all).
// Fully defensive: a parse/summarize failure yields [] rather than throwing.
export function summarizeConfigFile(
  relPath: string,
  text: string,
  opts: SummarizeOptions = {},
): ConfigItem[] {
  const doc = parseStructured(relPath, text);
  const ctx: SummarizeContext = {
    relPath,
    fileName: relPath.split('/').pop() ?? relPath,
  };
  const chain = [
    ...(opts.extraSummarizers ?? []),
    ...(opts.packSummarizers ?? []),
    ...CORE_SUMMARIZERS,
  ];
  for (const summarizer of chain) {
    let matched = false;
    try {
      matched = summarizer.match(relPath, doc);
    } catch {
      matched = false;
    }
    if (!matched) continue;
    let items: ConfigItem[] | null = null;
    try {
      items = summarizer.summarize(doc, ctx);
    } catch {
      items = null;
    }
    if (items && items.length > 0) return items;
  }
  return [];
}
