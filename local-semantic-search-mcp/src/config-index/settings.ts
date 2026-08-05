import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectStandards } from '../standards/registry.js';

// Per-project config-index settings, declared with no code in
// `<workspace>/.foundry/config.json`:
//   {
//     "configExtensions": [".yml", ".yaml", ".json"],   // which files are "config"
//     "configReaders": ["drupal"]                        // which type-specific packs
//   }
// Both optional. `configExtensions` defaults to YAML; when omitted, `configReaders`
// is AUTO-derived from the detected framework(s) — so Drupal projects get the
// Drupal pack with zero config, while the generic core covers everyone else.
export interface FoundryConfigFile {
  configExtensions?: string[];
  configReaders?: string[];
}

// Generic-first: only YAML is treated as config out of the box. A project opts
// into more (`.json`, `.toml`, …) via configExtensions.
export const DEFAULT_CONFIG_EXTENSIONS = ['.yml', '.yaml'];

// Detected framework -> the built-in reader pack that understands its config.
const FRAMEWORK_PACKS: Record<string, string> = { Drupal: 'drupal' };

const fileCache = new Map<string, FoundryConfigFile | null>();

function loadFoundryConfig(workspaceRoot: string): FoundryConfigFile | null {
  if (fileCache.has(workspaceRoot)) return fileCache.get(workspaceRoot)!;
  let parsed: FoundryConfigFile | null = null;
  try {
    const txt = readFileSync(join(workspaceRoot, '.foundry', 'config.json'), 'utf-8');
    const json = JSON.parse(txt);
    if (json && typeof json === 'object') parsed = json as FoundryConfigFile;
  } catch {
    parsed = null; // absent or malformed — fall back to defaults
  }
  fileCache.set(workspaceRoot, parsed);
  return parsed;
}

const normExt = (e: string): string => {
  const t = e.trim().toLowerCase();
  if (!t) return '';
  return t.startsWith('.') ? t : `.${t}`;
};

// The set of extensions treated as structured config for THIS project.
export function resolveConfigExtensions(workspaceRoot: string): Set<string> {
  const cfg = loadFoundryConfig(workspaceRoot);
  const declared = (cfg?.configExtensions ?? []).map(normExt).filter(Boolean);
  return new Set(declared.length ? declared : DEFAULT_CONFIG_EXTENSIONS);
}

// The type-specific reader packs enabled for THIS project — explicit list if the
// config file gives one (empty array = none), else auto-derived from frameworks.
export function resolveEnabledPacks(workspaceRoot: string): string[] {
  const cfg = loadFoundryConfig(workspaceRoot);
  if (cfg?.configReaders) return cfg.configReaders.map((r) => r.toLowerCase());
  const packs = new Set<string>();
  try {
    for (const fw of detectStandards(workspaceRoot).frameworks) {
      const p = FRAMEWORK_PACKS[fw];
      if (p) packs.add(p);
    }
  } catch {
    /* framework detection is best-effort */
  }
  return [...packs];
}

// --- Active extension set for isConfigFile ----------------------------------
// The indexer/chunker guard config out of the vector store by extension, but they
// only get a path (no workspaceRoot). Since a server process serves ONE workspace,
// we resolve the set once at startup and read it here (same pattern as the
// standards cache). Defaults to YAML until initialized.
let ACTIVE: Set<string> = new Set(DEFAULT_CONFIG_EXTENSIONS);

export function initConfigIndex(workspaceRoot: string): { extensions: string[]; packs: string[] } {
  ACTIVE = resolveConfigExtensions(workspaceRoot);
  return { extensions: [...ACTIVE], packs: resolveEnabledPacks(workspaceRoot) };
}

export function isConfigExtension(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return ACTIVE.has(path.slice(dot).toLowerCase());
}

export function clearConfigSettingsCache(): void {
  fileCache.clear();
  ACTIVE = new Set(DEFAULT_CONFIG_EXTENSIONS);
}
