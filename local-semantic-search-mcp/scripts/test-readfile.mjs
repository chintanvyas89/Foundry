// Unit test for read_file (two-pass). Drives the tool handler via a fake MCP
// server against a temp workspace. Covers: pass-1 outline (explicit + large-file
// default), pass-2 symbol body, line ranges, small-file whole read, relative +
// absolute input, path-traversal refusal, binary/missing handling.
//   node scripts/test-readfile.mjs
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerReadFileTool } from '../dist/tools/readFile.js';

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };
const ws = mkdtempSync(join(tmpdir(), 'readfile-'));

let handler;
registerReadFileTool({ tool: (_n, _d, _s, fn) => { handler = fn; } }, ws);
const textOf = (res) => res.content.map((c) => c.text).join('');

try {
  // A TS file with a top-level function and a class with a method.
  const ts = [
    'export function helper(x) {',      // 1
    '  return x + 1;',                  // 2
    '}',                                // 3
    '',                                 // 4
    'export class Widget {',            // 5
    '  render() {',                     // 6
    '    return this.helper();',        // 7
    '  }',                              // 8
    '}',                                // 9
  ].join('\n');
  writeFileSync(join(ws, 'widget.ts'), ts);
  writeFileSync(join(ws, 'bin.dat'), 'a\0b');

  // ---- pass 1: outline (explicit) ------------------------------------------
  const outline = await handler({ file: 'widget.ts', outline: true });
  const ot = textOf(outline);
  console.log('\n--- outline ---\n' + ot + '\n');
  assert(outline.structuredContent.mode === 'outline', 'outline mode reported');
  const names = outline.structuredContent.symbols.map((s) => s.name);
  assert(names.includes('helper') && names.includes('Widget') && names.includes('render'),
    'outline lists top-level fn, class, AND the method inside the class');
  assert(!/return x \+ 1/.test(ot), 'outline does NOT include bodies (token-lean)');

  // ---- pass 2: a specific symbol's body ------------------------------------
  const body = await handler({ file: 'widget.ts', symbol: 'render' });
  const bt = textOf(body);
  console.log('--- symbol body (render) ---\n' + bt + '\n');
  assert(body.structuredContent.mode === 'body', 'symbol read returns a body');
  assert(/return this\.helper\(\)/.test(bt), 'symbol body contains the method code');
  assert(/· method render/.test(bt), 'body header labels the symbol');
  assert(!/export function helper/.test(bt), 'symbol body is scoped to just that symbol');

  // relative vs absolute equivalence for a symbol read
  const bodyAbs = await handler({ file: join(ws, 'widget.ts'), symbol: 'render' });
  assert(textOf(bodyAbs) === bt, 'absolute path gives the same symbol body as relative');

  // unknown symbol lists what's available
  const missSym = await handler({ file: 'widget.ts', symbol: 'nope' });
  assert(/No symbol "nope"/.test(textOf(missSym)) && /Available:/.test(textOf(missSym)),
    'unknown symbol reports available names');

  // ---- explicit line range --------------------------------------------------
  const range = await handler({ file: 'widget.ts', startLine: 1, endLine: 3 });
  assert(/1  export function helper/.test(textOf(range)) && /3  }/.test(textOf(range)),
    'line range returns the requested slice with line numbers');

  // ---- small file, no args → whole file ------------------------------------
  const whole = await handler({ file: 'widget.ts' });
  assert(whole.structuredContent.mode === 'body' && whole.structuredContent.endLine === 9,
    'a small file with no args is returned whole');

  // ---- large file, no args → OUTLINE by default ----------------------------
  const big = ['export function a(){}', 'export function b(){}']
    .concat(Array.from({ length: 500 }, (_, i) => `// filler ${i}`)).join('\n');
  writeFileSync(join(ws, 'big.ts'), big);
  const bigRes = await handler({ file: 'big.ts' });
  assert(bigRes.structuredContent.mode === 'outline', 'a large file defaults to an outline, not a truncated dump');
  assert(bigRes.structuredContent.symbols.some((s) => s.name === 'a'), 'large-file outline lists its symbols');

  // ---- safety / edge cases --------------------------------------------------
  assert(/outside the workspace/.test(textOf(await handler({ file: '../secrets' }))), 'refuses path traversal');
  assert(/looks binary/.test(textOf(await handler({ file: 'bin.dat' }))), 'skips binary files');
  assert(/not found or unreadable/.test(textOf(await handler({ file: 'nope.ts' }))), 'reports a missing file');

  console.log('\nAll read_file (two-pass) tests passed.');
} finally {
  rmSync(ws, { recursive: true, force: true });
}
