import type { YamlValue } from './yaml.js';

// One summarized config item. `facts` is a compact natural-language description
// (+ key tokens) used for keyword search and to answer questions; it is NEVER
// embedded. `startLine` is optional — most config files are a single item, so it
// defaults to 1 (the file top) when a summarizer doesn't pin a line.
export interface ConfigItem {
  id: string;
  type: string;
  label?: string;
  deps?: string;
  facts: string;
  startLine?: number;
}

export interface SummarizeContext {
  // Workspace-relative, forward-slash path.
  relPath: string;
  // Basename, e.g. `views.view.frontpage.yml`.
  fileName: string;
}

// A pluggable reader of ONE ready-made config format. `match` is a cheap
// filename/shape test; `summarize` turns the parsed document into items. Return
// null/[] to defer to the next summarizer (the generic one is the catch-all).
// Add a new format = a new file + one line in `summarizers/index.ts`.
export interface ConfigSummarizer {
  id: string;
  match(relPath: string, doc: YamlValue): boolean;
  summarize(doc: YamlValue, ctx: SummarizeContext): ConfigItem[] | null;
}
