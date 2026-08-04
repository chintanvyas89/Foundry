// Unit test for PHP + Drupal tree-sitter chunking. Writes sample .php and .module
// sources, runs the real tree-sitter chunker, and asserts that classes, top-level
// functions (Drupal hooks), interfaces, and traits become named chunks — the fix
// for PHP files being unsearchable (fixed-window, no symbol names) before.
//   node scripts/test-php.mjs
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chunkWithTreeSitter, supportsTreeSitter } from '../dist/chunking/treeSitterChunker.js';
import { chunkFile } from '../dist/chunking/chunker.js';

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };
const dir = mkdtempSync(join(tmpdir(), 'php-chunk-'));

try {
  // --- extension mapping -----------------------------------------------------
  for (const ext of ['.php', '.module', '.inc', '.install', '.theme', '.profile', '.engine']) {
    assert(supportsTreeSitter(ext), `tree-sitter supports ${ext}`);
  }
  assert(!supportsTreeSitter('.txt'), 'unrelated extension still unsupported');

  // --- a Drupal route provider class (the reported failure shape) ------------
  const classFile = join(dir, 'MarketActivityRouteProvider.php');
  writeFileSync(
    classFile,
    `<?php

namespace Drupal\\market\\Entity;

use Drupal\\Core\\Entity\\Routing\\DefaultHtmlRouteProvider;

/**
 * Provides routes for Market entities.
 */
class MarketActivityRouteProvider extends DefaultHtmlRouteProvider {

  public function getRoutes($entity_type) {
    $collection = parent::getRoutes($entity_type);
    return $collection;
  }

}

interface MarketInterface {}

trait MarketHelperTrait {
  public function help() {}
}
`,
  );
  const classChunks = await chunkWithTreeSitter(classFile, '.php');
  const syms = classChunks.map((c) => c.symbol);
  console.log('\n.php symbols:', syms);
  assert(syms.includes('MarketActivityRouteProvider'), 'class becomes a named chunk (search_symbol can now find it)');
  assert(syms.includes('MarketInterface'), 'interface becomes a named chunk');
  assert(syms.includes('MarketHelperTrait'), 'trait becomes a named chunk');
  // Whole-class granularity: the method is subsumed into the class chunk, matching
  // the TS/Java tiers (chunker stops descending at a matched symbol node).
  const cls = classChunks.find((c) => c.symbol === 'MarketActivityRouteProvider');
  assert(cls.text.includes('getRoutes'), 'class chunk contains its methods');

  // --- a Drupal .module file with top-level hooks ----------------------------
  const moduleFile = join(dir, 'market.module');
  writeFileSync(
    moduleFile,
    `<?php

/**
 * @file
 * Market module hooks.
 */

function market_form_alter(&$form, $form_state, $form_id) {
  $form['#attached']['library'][] = 'market/global';
}

function market_menu() {
  return [];
}
`,
  );
  // .module has no tree-sitter grammar by extension alone unless mapped — verify
  // it both maps AND that chunkFile (the real routing path) picks it up.
  const modChunks = await chunkWithTreeSitter(moduleFile, '.module');
  const modSyms = modChunks.map((c) => c.symbol);
  console.log('.module symbols:', modSyms);
  assert(modSyms.includes('market_form_alter'), 'Drupal hook is its own named chunk');
  assert(modSyms.includes('market_menu'), 'second hook is its own named chunk');

  // chunkFile is what the indexer calls; with no bridge it should reach tree-sitter
  // (not fixed-window) for a .module file now.
  const routed = await chunkFile(moduleFile, dir);
  assert(routed.some((c) => c.symbol === 'market_form_alter'), 'chunkFile routes .module to tree-sitter (named chunks, not fixed-window)');

  console.log('\nAll PHP/Drupal chunking tests passed.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
