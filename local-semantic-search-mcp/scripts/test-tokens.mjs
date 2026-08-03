// End-to-end check of token-efficient output: a compact search (signatures
// only), then expand=[...] to pull full bodies without re-querying.
//   node scripts/test-tokens.mjs <workspaceRoot>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const workspaceRoot = process.argv[2] || process.cwd();
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, WORKSPACE_ROOT: workspaceRoot },
  stderr: 'ignore',
});
const client = new Client({ name: 'token-test', version: '0.0.1' });
await client.connect(transport);

const call = (args) =>
  client.callTool({ name: 'semantic_search', arguments: args }, undefined, { timeout: 300000 });
const textOf = (res) => res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

// 1. Compact (default) search.
const compact = await call({ query: 'where is cosine similarity computed', topK: 5 });
const compactText = textOf(compact);
console.log('===== COMPACT (default) =====\n' + compactText);

// 2. Same query with detail=full, to compare size.
const full = await call({ query: 'where is cosine similarity computed', topK: 5, detail: 'full' });
const fullText = textOf(full);

// 3. Expand results 1 and 2 from the compact search — no query.
const expanded = await call({ expand: [1, 2] });
const expandedText = textOf(expanded);
console.log('\n===== EXPAND [1,2] =====\n' + expandedText.slice(0, 600) + '\n...[truncated]');

// 4. Expand with no prior valid numbers on a fresh nonsense expand.
const bad = await call({ expand: [999] });
const badText = textOf(bad);

// Assertions
const assert = (c, m) => { if (!c) { console.error('\nFAIL:', m); process.exit(1); } console.log('ok  -', m); };
console.log('\n----- checks -----');
assert(compactText.length < fullText.length, `compact is smaller than full (${compactText.length} < ${fullText.length} chars)`);
assert(!compactText.includes('```'), 'compact output has no fenced code bodies');
assert(compactText.includes('Signatures only'), 'compact output tells the caller how to expand');
assert(fullText.includes('```'), 'full output includes fenced code bodies');
assert(expandedText.includes('```'), 'expand returns full code bodies');
assert(/not from the last search/i.test(badText), 'expand with unknown numbers explains itself');

await client.close();
console.log('\nAll token-efficiency checks passed.');
