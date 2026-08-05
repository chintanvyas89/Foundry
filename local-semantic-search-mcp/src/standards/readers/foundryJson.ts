import { join } from 'node:path';
import type { DetectContext, DetectedStandard, StandardReader, Psr4Entry } from '../types.js';

// Per-project override so a project can DECLARE its standards with no code — for a
// bespoke framework/layout, or any ecosystem we don't have a built-in reader for.
// <workspace>/.foundry/standards.json:
//   { "frameworks": ["MyFw"], "psr4": { "App\\": "app/src" },
//     "codingStandards": ["PSR-12"] }

interface FoundryStandards {
  frameworks?: string[];
  psr4?: Record<string, string | string[]>;
  codingStandards?: string[];
  notes?: string[];
}

const norm = (p: string): string => join(p).split('\\').join('/').replace(/\/+$/, '');

export const foundryJsonReader: StandardReader = {
  id: 'foundry-json',
  read(ctx: DetectContext): Partial<DetectedStandard> | null {
    const json = ctx.readJson<FoundryStandards>('.foundry/standards.json');
    if (!json) return null;

    const psr4: Psr4Entry[] = [];
    for (const [prefix, dirs] of Object.entries(json.psr4 ?? {})) {
      for (const d of Array.isArray(dirs) ? dirs : [dirs]) {
        psr4.push({ prefix, dir: norm(d), source: 'foundry-json' });
      }
    }

    return {
      frameworks: json.frameworks ?? [],
      psr4,
      codingStandards: json.codingStandards ?? [],
      notes: ['from .foundry/standards.json (project override)'],
    };
  },
};
