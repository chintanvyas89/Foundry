// Unit test for read_file. Drives the tool handler via a fake MCP server against
// a temp workspace. Covers relative + absolute input, line ranges, the large-file
// cap, path-traversal refusal, and binary/missing handling.
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
  const big = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
  writeFileSync(join(ws, 'store.ts'), big);
  writeFileSync(join(ws, 'bin.dat'), 'a\0b');

  // relative input
  const rel = await handler({ file: 'store.ts', startLine: 2, endLine: 4 });
  const rt = textOf(rel);
  assert(/store\.ts \(lines 2-4 of 500\)/.test(rt), 'header shows range and total');
  assert(/2  line 2/.test(rt) && /4  line 4/.test(rt), 'returns the requested slice with line numbers');
  assert(rel.structuredContent.startLine === 2 && rel.structuredContent.endLine === 4, 'structuredContent carries the range');

  // absolute input resolves the same
  const abs = await handler({ file: join(ws, 'store.ts'), startLine: 2, endLine: 4 });
  assert(textOf(abs) === rt, 'absolute path gives the same result as relative');

  // large file cap
  const capped = await handler({ file: 'store.ts' });
  assert(capped.structuredContent.endLine === 400 && capped.structuredContent.truncated, 'caps a large file at 400 lines');
  assert(/more line\(s\)\. Request a range/.test(textOf(capped)), 'notes truncation + how to get more');

  // path traversal refusal
  const esc = await handler({ file: '../secrets.txt' });
  assert(/outside the workspace/.test(textOf(esc)) && esc.structuredContent.error === 'outside-workspace', 'refuses to read outside the workspace');

  // binary + missing
  assert(/looks binary/.test(textOf(await handler({ file: 'bin.dat' }))), 'skips binary files');
  assert(/not found or unreadable/.test(textOf(await handler({ file: 'nope.ts' }))), 'reports a missing file');

  console.log('\nAll read_file tests passed.');
} finally {
  rmSync(ws, { recursive: true, force: true });
}
