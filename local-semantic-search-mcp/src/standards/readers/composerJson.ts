import { join } from 'node:path';
import type { DetectContext, DetectedStandard, StandardReader, Psr4Entry } from '../types.js';

// Fallback for when vendor/ isn't installed: the ROOT composer.json's own declared
// autoload + require. Reads the project's declared PSR-4 (its own namespaces) and
// detects the framework from require/type. Complements composerVendor (which covers
// dependencies); here first-writer-wins in the registry keeps vendor authoritative
// when both are present.

interface ComposerJson {
  type?: string;
  autoload?: { 'psr-4'?: Record<string, string | string[]> };
  'autoload-dev'?: { 'psr-4'?: Record<string, string | string[]> };
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
}

const norm = (p: string): string => join(p).split('\\').join('/').replace(/\/+$/, '');

export const composerJsonReader: StandardReader = {
  id: 'composer-json',
  read(ctx: DetectContext): Partial<DetectedStandard> | null {
    const json = ctx.readJson<ComposerJson>('composer.json');
    if (!json) return null;

    const psr4: Psr4Entry[] = [];
    for (const block of [json.autoload, json['autoload-dev']]) {
      for (const [prefix, dirs] of Object.entries(block?.['psr-4'] ?? {})) {
        for (const d of Array.isArray(dirs) ? dirs : [dirs]) {
          psr4.push({ prefix, dir: norm(d), source: 'composer-json' });
        }
      }
    }

    const frameworks: string[] = [];
    const req = { ...json.require, ...json['require-dev'] };
    if ('drupal/core' in req || (json.type ?? '').startsWith('drupal-')) frameworks.push('Drupal');
    if ('laravel/framework' in req) frameworks.push('Laravel');
    if ('symfony/framework-bundle' in req || 'symfony/symfony' in req) frameworks.push('Symfony');

    if (psr4.length === 0 && frameworks.length === 0) return null;
    return { frameworks, psr4, notes: ['read from root composer.json'] };
  },
};
