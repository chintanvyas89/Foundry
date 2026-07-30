import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  model: z.string().default('onnx-community/embeddinggemma-300m-ONNX'),
  dtype: z.string().default('q8'),
  topKDefault: z.number().int().positive().default(8),
  maxChunkTokens: z.number().int().positive().default(512),
  // Extra ignore patterns (gitignore syntax) applied on top of .gitignore,
  // .sweignore, and the built-in defaults. A convenient place to exclude
  // folders without a separate .sweignore file, e.g. ["tests/", "vendor/"].
  exclude: z.array(z.string()).default([]),
});

export type Config = z.infer<typeof configSchema>;

// Reported alongside the parsed config so the caller can log which file (if
// any) actually contributed — misplaced configs (e.g. dropped inside
// .swe-search/ instead of the workspace root) otherwise fail silently, and
// the user never sees their exclude patterns take effect.
export interface LoadedConfig {
  config: Config;
  source: string | null; // absolute path if a file was read, null if using defaults
  expectedPath: string; // where a config file would be picked up from
}

const CONFIG_FILENAME = '.swe-search.config.json';

export function loadConfig(workspaceRoot: string): LoadedConfig {
  const configPath = join(workspaceRoot, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return { config: configSchema.parse({}), source: null, expectedPath: configPath };
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  return { config: configSchema.parse(raw), source: configPath, expectedPath: configPath };
}
