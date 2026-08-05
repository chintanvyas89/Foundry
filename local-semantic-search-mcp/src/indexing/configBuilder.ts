import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { VectorStore, ConfigRow } from '../storage/store.js';
import { buildIgnoreMatcher, isIgnored, type Ignore } from '../ignore/ignoreMatcher.js';
import {
  isConfigFile,
  summarizeConfigFile,
  type ConfigSummarizer,
} from '../config-index/registry.js';
import { resolveConfigExtensions, resolveEnabledPacks } from '../config-index/settings.js';
import { resolvePackSummarizers } from '../config-index/packs/index.js';

// Builds the embedding-free config index (`config` + `config_fts`) by parsing
// every project `.yml`/`.yaml` into structured facts. YAML is NEVER embedded —
// this reads files and writes a metadata table, exactly like the symbol/usage
// builders, but it needs NO LSP bridge (pure parsing) so it runs headless too.
//
// It walks with its OWN ignore matcher (NOT the user's embed `exclude`): config
// dirs are often excluded precisely to keep YAML out of the vector index, and
// that must not also hide them from THIS index. `vendor` (third-party) is skipped
// so the index stays the project's own config.

// Third-party trees that are never "the project's config".
const CONFIG_WALK_SKIP = ['vendor'];

// Config files are small; refuse anything pathological.
const MAX_FILE_BYTES = 512 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ConfigBuildStats {
  files: number; // config files found
  filesProcessed: number; // (re)summarized this run
  filesSkipped: number; // unchanged since last run (resumable/incremental)
  filesPruned: number; // removed (deleted / no longer present)
  items: number; // config items written this run
  bridgeDown: boolean; // always false — config needs no bridge (shape parity)
}

export interface ConfigBuildProgress {
  doneFiles: number;
  totalFiles: number;
  items: number;
}

export interface ConfigBuildOptions {
  onProgress?: (p: ConfigBuildProgress) => void;
  delayMs?: number;
  // Project-contributed summarizers, tried before the built-ins.
  extraSummarizers?: ConfigSummarizer[];
}

function hasConfigExt(path: string, extensions: Set<string>): boolean {
  const dot = path.lastIndexOf('.');
  return dot !== -1 && extensions.has(path.slice(dot).toLowerCase());
}

function walkConfig(
  workspaceRoot: string,
  dir: string,
  ig: Ignore,
  extensions: Set<string>,
  out: string[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (isIgnored(ig, workspaceRoot, full)) continue;
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkConfig(workspaceRoot, full, ig, extensions, out);
    } else if (stat.isFile() && hasConfigExt(full, extensions)) {
      out.push(full);
    }
  }
}

function toRel(workspaceRoot: string, abs: string): string {
  return relative(workspaceRoot, abs).split(sep).join('/');
}

function summarizeToRows(
  relPath: string,
  text: string,
  extras: ConfigSummarizer[],
  packs: ConfigSummarizer[],
): ConfigRow[] {
  return summarizeConfigFile(relPath, text, {
    extraSummarizers: extras,
    packSummarizers: packs,
  }).map((item) => ({
    id: item.id,
    type: item.type,
    label: item.label ?? null,
    deps: item.deps ?? null,
    facts: item.facts,
    startLine: item.startLine ?? 1,
  }));
}

// One-time (resumable) whole-repo build. Skips files whose content hash is
// unchanged since the last run, and prunes items for files that disappeared.
export async function buildConfig(
  workspaceRoot: string,
  store: VectorStore,
  opts: ConfigBuildOptions = {},
): Promise<ConfigBuildStats> {
  const delayMs = opts.delayMs ?? 0;
  const extras = opts.extraSummarizers ?? [];
  // Per-project settings: which extensions are config, and which type-specific
  // packs (e.g. Drupal) to layer on top of the generic core.
  const extensions = resolveConfigExtensions(workspaceRoot);
  const packs = resolvePackSummarizers(resolveEnabledPacks(workspaceRoot));

  const ig = buildIgnoreMatcher(workspaceRoot, CONFIG_WALK_SKIP);
  const absFiles: string[] = [];
  walkConfig(workspaceRoot, workspaceRoot, ig, extensions, absFiles);

  const stats: ConfigBuildStats = {
    files: absFiles.length,
    filesProcessed: 0,
    filesSkipped: 0,
    filesPruned: 0,
    items: 0,
    bridgeDown: false,
  };

  const seen = new Set<string>();
  let done = 0;
  for (const abs of absFiles) {
    done++;
    const rel = toRel(workspaceRoot, abs);
    seen.add(rel);
    let content: Buffer;
    try {
      content = readFileSync(abs);
    } catch {
      continue; // removed mid-walk
    }
    if (content.byteLength > MAX_FILE_BYTES) {
      stats.filesSkipped++;
      opts.onProgress?.({ doneFiles: done, totalFiles: absFiles.length, items: stats.items });
      continue;
    }
    const hash = createHash('sha1').update(content).digest('hex');
    if (store.getConfigFileHash(rel) === hash) {
      stats.filesSkipped++;
      opts.onProgress?.({ doneFiles: done, totalFiles: absFiles.length, items: stats.items });
      continue;
    }
    const rows = summarizeToRows(rel, content.toString('utf-8'), extras, packs);
    store.replaceConfig(rel, rows);
    store.setConfigFileHash(rel, hash);
    stats.filesProcessed++;
    stats.items += rows.length;
    opts.onProgress?.({ doneFiles: done, totalFiles: absFiles.length, items: stats.items });
    if (delayMs > 0) await sleep(delayMs);
  }

  // Prune config for files that no longer exist / no longer match.
  for (const rel of store.listConfigFiles()) {
    if (!seen.has(rel)) {
      store.deleteConfigForFile(rel);
      store.deleteConfigFile(rel);
      stats.filesPruned++;
    }
  }

  return stats;
}

// Incremental update for a single file (called from the watcher). No-ops unless
// the config index has already been built. Returns what happened, for logging.
export function updateFileConfig(
  workspaceRoot: string,
  store: VectorStore,
  relFile: string,
): 'updated' | 'removed' | 'skip' {
  if (store.configStats().filesBuilt === 0) return 'skip';
  if (!isConfigFile(relFile)) return 'skip';
  const abs = join(workspaceRoot, relFile);
  let content: Buffer;
  try {
    content = readFileSync(abs);
  } catch {
    // File gone — drop its rows.
    store.deleteConfigForFile(relFile);
    store.deleteConfigFile(relFile);
    return 'removed';
  }
  if (content.byteLength > MAX_FILE_BYTES) return 'skip';
  const hash = createHash('sha1').update(content).digest('hex');
  if (store.getConfigFileHash(relFile) === hash) return 'skip';
  const packs = resolvePackSummarizers(resolveEnabledPacks(workspaceRoot));
  const rows = summarizeToRows(relFile, content.toString('utf-8'), [], packs);
  store.replaceConfig(relFile, rows);
  store.setConfigFileHash(relFile, hash);
  return 'updated';
}
