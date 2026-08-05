import { join } from 'node:path';
import type { DetectContext, DetectedStandard, StandardReader, Psr4Entry, ClassMapEntry } from '../types.js';

// Reads Composer's GENERATED, authoritative artifacts (present after `composer
// install`) rather than reimplementing PSR-4:
//   vendor/composer/installed.json      → every package's psr-4 map + the full
//                                          dependency list (→ framework detection)
//   vendor/composer/autoload_classmap.php → exact FQCN → file (optimized autoloader)
// This covers a project's dependencies AND its own root package's deps, including
// Drupal core/contrib. When vendor/ isn't installed, composerJson.ts is the fallback.

interface InstalledPackage {
  name?: string;
  type?: string;
  'install-path'?: string;
  autoload?: { 'psr-4'?: Record<string, string | string[]> };
}

const FRAMEWORK_MARKERS: Array<[RegExp, string]> = [
  [/^drupal\/core$/, 'Drupal'],
  [/^laravel\/framework$/, 'Laravel'],
  [/^symfony\/(framework-bundle|symfony)$/, 'Symfony'],
];

const norm = (p: string): string => join(p).split('\\').join('/').replace(/\/+$/, '');

export const composerVendorReader: StandardReader = {
  id: 'composer-vendor',
  read(ctx: DetectContext): Partial<DetectedStandard> | null {
    const installed = ctx.readJson<InstalledPackage[] | { packages?: InstalledPackage[] }>(
      'vendor/composer/installed.json',
    );
    if (!installed) return null;

    const packages: InstalledPackage[] = Array.isArray(installed) ? installed : installed.packages ?? [];
    const psr4: Psr4Entry[] = [];
    const frameworks = new Set<string>();

    for (const pkg of packages) {
      if (pkg.name) {
        for (const [re, fw] of FRAMEWORK_MARKERS) if (re.test(pkg.name)) frameworks.add(fw);
      }
      // install-path is relative to vendor/composer/; fall back to vendor/<name>.
      const pkgDir = pkg['install-path']
        ? norm(join('vendor/composer', pkg['install-path']))
        : pkg.name
          ? norm(join('vendor', pkg.name))
          : null;
      if (!pkgDir) continue;

      const map = pkg.autoload?.['psr-4'] ?? {};
      for (const [prefix, dirs] of Object.entries(map)) {
        for (const d of Array.isArray(dirs) ? dirs : [dirs]) {
          psr4.push({ prefix, dir: norm(join(pkgDir, d)), source: 'composer-vendor' });
        }
      }
    }

    const classMap = readClassMap(ctx);
    const notes = ['PSR-4 + frameworks read from Composer\'s generated vendor/composer/installed.json'];
    if (classMap.length) notes.push(`exact class map from autoload_classmap.php (${classMap.length} classes)`);

    return { frameworks: [...frameworks], psr4, classMap, notes };
  },
};

// Composer's classmap is a generated PHP array `'Class' => $vendorDir|$baseDir . '/path'`.
// $vendorDir === <ws>/vendor, $baseDir === <ws>. Regex-extract (machine-written, stable).
function readClassMap(ctx: DetectContext): ClassMapEntry[] {
  const raw = ctx.readText('vendor/composer/autoload_classmap.php');
  if (!raw) return [];
  const re = /'((?:[^'\\]|\\.)+)'\s*=>\s*\$(vendorDir|baseDir)\s*\.\s*'([^']+)'/g;
  const out: ClassMapEntry[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null && out.length < 50000) {
    const fqcn = m[1].replace(/\\\\/g, '\\').replace(/^\\/, '');
    const suffix = m[3].replace(/^\//, '');
    const file = norm(m[2] === 'vendorDir' ? join('vendor', suffix) : suffix);
    out.push({ fqcn, file, source: 'composer-vendor' });
  }
  return out;
}
