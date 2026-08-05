// Pluggable project-standards detection. Each "reader" is a thin adapter over a
// ready-made source the ecosystem already produces (Composer's generated
// vendor/composer/installed.json, a root composer.json, tsconfig paths, …) — we
// READ those rather than reimplementing PSR-4/framework rules. The registry runs
// every reader and merges their results; adding a standard = adding one reader.

// A single PSR-4-style namespace→directory mapping.
export interface Psr4Entry {
  prefix: string; // e.g. "Drupal\\market\\" (always ends with a backslash)
  dir: string; // workspace-relative directory, '/'-joined, no trailing slash
  source: string; // which reader produced it (composer-vendor / composer-json / drupal-info / foundry-json)
}

// An exact fully-qualified-class-name → file mapping (e.g. Composer's classmap).
export interface ClassMapEntry {
  fqcn: string; // no leading backslash
  file: string; // workspace-relative path
  source: string;
}

export interface DetectedStandard {
  frameworks: string[]; // e.g. ["Drupal"]
  psr4: Psr4Entry[];
  classMap: ClassMapEntry[];
  codingStandards: string[]; // e.g. ["PSR-12 (phpcs)"]
  notes: string[]; // free-form, e.g. how detection was sourced
}

// Read-only, bounded filesystem helpers handed to each reader so they never walk
// the whole tree unbounded or read a giant file into memory.
export interface DetectContext {
  workspaceRoot: string;
  // Text of a workspace-relative file, or null if missing / unreadable / too big.
  readText(rel: string): string | null;
  // Parsed JSON of a workspace-relative file, or null.
  readJson<T = unknown>(rel: string): T | null;
  exists(rel: string): boolean;
  // Workspace-relative paths ending with `suffix` (e.g. ".info.yml"), from a single
  // bounded recursive walk that skips vendor/node_modules/.git/.swe-search.
  glob(suffix: string, cap: number): string[];
}

// A reader contributes a partial standard; the registry merges partials.
export interface StandardReader {
  id: string;
  read(ctx: DetectContext): Partial<DetectedStandard> | null;
}

export function emptyStandard(): DetectedStandard {
  return { frameworks: [], psr4: [], classMap: [], codingStandards: [], notes: [] };
}
