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

const CONFIG_FILENAME = '.swe-search.config.json';

export function loadConfig(workspaceRoot: string): Config {
  const configPath = join(workspaceRoot, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return configSchema.parse({});
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  return configSchema.parse(raw);
}
