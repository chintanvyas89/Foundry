import type { ConfigSummarizer } from '../types.js';
import { DRUPAL_SUMMARIZERS } from './drupal/index.js';

// Registry of built-in type-specific reader packs, keyed by the name used in
// `.foundry/config.json` `configReaders` (and in framework auto-detection). Add a
// pack = a folder under packs/ exporting its summarizers + one line here.
export const PACKS: Record<string, ConfigSummarizer[]> = {
  drupal: DRUPAL_SUMMARIZERS,
};

export function resolvePackSummarizers(names: string[]): ConfigSummarizer[] {
  const out: ConfigSummarizer[] = [];
  for (const name of names) {
    const pack = PACKS[name.toLowerCase()];
    if (pack) out.push(...pack);
  }
  return out;
}
