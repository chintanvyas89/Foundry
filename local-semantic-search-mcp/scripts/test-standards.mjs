// Unit test for pluggable project-standards detection + FQCN resolution. Builds a
// temp PHP/Drupal-shaped workspace (Composer vendor artifacts, root composer.json,
// a Drupal module .info.yml, a .foundry override), then drives the registry, the
// resolver, and the project_standards / read_file tool handlers. Headless — no LSP
// bridge, so the OFFLINE readers are exercised.
//   node scripts/test-standards.mjs
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectStandards, clearStandardsCache } from '../dist/standards/registry.js';
import { resolveFqcn } from '../dist/standards/resolve.js';
import { registerProjectStandardsTool } from '../dist/tools/projectStandards.js';
import { registerReadFileTool } from '../dist/tools/readFile.js';

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };
const ws = mkdtempSync(join(tmpdir(), 'standards-'));
const mk = (p) => mkdirSync(join(ws, p), { recursive: true });
const wr = (p, c) => { mk(p.split('/').slice(0, -1).join('/') || '.'); writeFileSync(join(ws, p), c); };

try {
  // Composer's generated vendor artifacts (the authoritative source).
  wr('vendor/composer/installed.json', JSON.stringify({
    packages: [
      { name: 'drupal/core', type: 'drupal-core', 'install-path': '../../web/core',
        autoload: { 'psr-4': { 'Drupal\\Core\\': 'lib/Drupal/Core' } } },
      { name: 'acme/lib', 'install-path': '../acme/lib', autoload: { 'psr-4': { 'Acme\\Lib\\': 'src' } } },
    ],
  }));
  wr('vendor/composer/autoload_classmap.php',
    "<?php\n$vendorDir = dirname(__DIR__);\n$baseDir = dirname($vendorDir);\nreturn array(\n" +
    "    'Drupal\\\\market\\\\Service\\\\Widget' => $baseDir . '/web/modules/custom/market/src/Service/Widget.php',\n);\n");

  // Root composer.json (the project's own namespaces + require).
  wr('composer.json', JSON.stringify({
    type: 'project', autoload: { 'psr-4': { 'App\\': 'app/src' } }, require: { 'drupal/core': '^10' },
  }));

  // A Drupal custom module — namespace is runtime-registered, so only *.info.yml reveals it.
  wr('web/modules/custom/market/market.info.yml', 'name: Market\ntype: module\ncore_version_requirement: ^10\n');
  wr('web/modules/custom/market/src/Entity/Activity.php',
    '<?php\nnamespace Drupal\\market\\Entity;\nclass Activity {\n  public function label() { return \'x\'; }\n}\n');
  wr('web/modules/custom/market/src/Service/Widget.php',
    '<?php\nnamespace Drupal\\market\\Service;\nclass Widget {}\n');

  // Coding standard config + per-project override.
  wr('phpcs.xml.dist', '<?xml version="1.0"?>\n<ruleset><rule ref="Drupal"/></ruleset>\n');
  wr('.foundry/standards.json', JSON.stringify({ frameworks: ['Acme'], psr4: { 'My\\': 'lib' } }));

  // ---- registry merges every source, with correct provenance ---------------
  const std = detectStandards(ws);
  console.log('\nframeworks:', std.frameworks, '\npsr4:', std.psr4.map((e) => `${e.prefix}->${e.dir} [${e.source}]`));
  assert(std.frameworks.includes('Drupal'), 'framework Drupal detected (from vendor + info.yml + composer.json)');
  assert(std.frameworks.includes('Acme'), 'framework from .foundry override included');
  const bySrc = (src) => std.psr4.filter((e) => e.source === src).length;
  assert(bySrc('composer-vendor') >= 2, 'PSR-4 from Composer vendor (drupal/core + acme)');
  assert(std.psr4.some((e) => e.prefix === 'Drupal\\market\\' && e.source === 'drupal-info'), 'Drupal module namespace synthesized from .info.yml');
  assert(std.psr4.some((e) => e.prefix === 'App\\' && e.source === 'composer-json'), 'root composer.json PSR-4 included');
  assert(std.psr4.some((e) => e.prefix === 'My\\' && e.source === 'foundry-json'), '.foundry override PSR-4 included');
  assert(std.codingStandards.some((c) => /Drupal/.test(c)), 'coding standard read from phpcs ruleset');
  assert(std.classMap.length >= 1, 'exact class map parsed from autoload_classmap.php');

  // ---- FQCN resolution ------------------------------------------------------
  const viaPsr4 = resolveFqcn('Drupal\\market\\Entity\\Activity', std, ws);
  assert(viaPsr4 && viaPsr4.rel === 'web/modules/custom/market/src/Entity/Activity.php', 'FQCN resolves via PSR-4 (Drupal module namespace)');
  const withLeadingSlash = resolveFqcn('\\Drupal\\market\\Entity\\Activity', std, ws);
  assert(withLeadingSlash && withLeadingSlash.rel === viaPsr4.rel, 'leading backslash tolerated');
  const viaClassmap = resolveFqcn('Drupal\\market\\Service\\Widget', std, ws);
  assert(viaClassmap && viaClassmap.rel === 'web/modules/custom/market/src/Service/Widget.php', 'FQCN resolves (classmap or PSR-4)');
  assert(resolveFqcn('No\\Such\\Class', std, ws) === null, 'unresolvable FQCN returns null');
  assert(resolveFqcn('Drupal\\market\\Entity\\Ghost', std, ws) === null, 'prefix match but missing file returns null');

  // ---- pluggability: an extra reader is picked up ---------------------------
  clearStandardsCache();
  const fake = { id: 'fake', read: () => ({ frameworks: ['FakeFw'], psr4: [{ prefix: 'Fake\\', dir: 'fake', source: 'fake' }] }) };
  const withFake = detectStandards(ws, [fake]);
  assert(withFake.frameworks.includes('FakeFw') && withFake.psr4.some((e) => e.source === 'fake'), 'a plugged-in extra reader contributes to detection');

  // ---- tool handlers --------------------------------------------------------
  let psHandler;
  registerProjectStandardsTool({ tool: (_n, _d, _s, fn) => { psHandler = fn; } }, ws);
  const ps = await psHandler({});
  assert(ps.structuredContent.frameworks.includes('Drupal') && ps.structuredContent.psr4.length > 0, 'project_standards returns framework + PSR-4 map');
  assert(/Drupal\\market\\ → web\/modules\/custom\/market\/src/.test(ps.content[0].text), 'project_standards text shows the namespace→dir map');

  let rfHandler;
  registerReadFileTool({ tool: (_n, _d, _s, fn) => { rfHandler = fn; } }, ws);
  const rf = await rfHandler({ file: 'Drupal\\market\\Entity\\Activity' });
  const rfText = rf.content.map((c) => c.text).join('');
  console.log('\n--- read_file(FQCN) ---\n' + rfText + '\n');
  assert(/Activity/.test(rfText) && !/error/.test(JSON.stringify(rf.structuredContent ?? {})), 'read_file resolves an FQCN to its file and reads it (offline)');

  console.log('\nAll project-standards tests passed.');
} finally {
  rmSync(ws, { recursive: true, force: true });
}
