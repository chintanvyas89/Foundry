import { join } from 'node:path';
import type { DetectContext, DetectedStandard, StandardReader, Psr4Entry } from '../types.js';

// Drupal modules/themes register their `Drupal\<name>\` namespace at RUNTIME (via
// DrupalKernel), so it is NOT in Composer's generated psr-4 — meaning custom AND
// contrib module classes wouldn't resolve from vendor artifacts alone. Drupal's
// convention is fixed, though: a `<name>.info.yml` marks an extension whose
// namespace maps to `<its dir>/src`. We read those markers to synthesize the map.

const MODULE_INFO_CAP = 3000;
const norm = (p: string): string => join(p).split('\\').join('/').replace(/\/+$/, '');

export const drupalInfoReader: StandardReader = {
  id: 'drupal-info',
  read(ctx: DetectContext): Partial<DetectedStandard> | null {
    const infos = ctx.glob('.info.yml', MODULE_INFO_CAP);
    if (infos.length === 0) return null;

    const psr4: Psr4Entry[] = [];
    let looksDrupal = false;
    for (const info of infos) {
      const slash = info.lastIndexOf('/');
      const dir = slash < 0 ? '' : info.slice(0, slash);
      const base = (slash < 0 ? info : info.slice(slash + 1)).replace(/\.info\.yml$/, '');
      if (!base) continue;
      // A Drupal-ish marker in the file lifts confidence for framework detection.
      const raw = ctx.readText(info) ?? '';
      if (/^\s*(type:\s*(module|theme|profile)|core_version_requirement:|core:)/m.test(raw)) {
        looksDrupal = true;
      }
      psr4.push({ prefix: `Drupal\\${base}\\`, dir: norm(join(dir, 'src')), source: 'drupal-info' });
    }

    if (psr4.length === 0) return null;
    return {
      frameworks: looksDrupal ? ['Drupal'] : [],
      psr4,
      notes: [`Drupal module namespaces synthesized from ${psr4.length} *.info.yml marker(s)`],
    };
  },
};
