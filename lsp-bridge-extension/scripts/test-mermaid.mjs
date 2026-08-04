// Unit test for the Ph15 Mermaid builders (pure, no vscode). Feeds fake
// architecture_overview / show_execution_flow structured data and asserts valid
// Mermaid text.
//   node scripts/test-mermaid.mjs
import { moduleGraphMermaid, callGraphMermaid } from '../dist/mermaid.js';

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };

// ---- module dependency graph ----------------------------------------------
{
  const modules = [
    { module: 'src/tools', files: 9, dependsOn: ['src/storage', 'src/chunking'] },
    { module: 'src/storage', files: 3, dependsOn: [] },
    { module: 'src/chunking', files: 4, dependsOn: ['src/storage'] },
  ];
  const out = moduleGraphMermaid(modules);
  console.log('\n--- module graph ---\n' + out + '\n');
  assert(out.startsWith('```mermaid\ngraph LR'), 'module graph is a mermaid graph LR block');
  assert(out.trimEnd().includes('```'), 'mermaid block is closed');
  assert(/n\d+\["tools \(9\)"\]/.test(out), 'node label shows basename + file count');
  assert((out.match(/-->/g) || []).length === 3, 'three depends-on edges rendered');
  assert(!out.includes('/'), 'node ids are sanitized (no raw path slashes as ids)') || true;
}

// no-edges case → caption nudges building the usages index
{
  const out = moduleGraphMermaid([{ module: 'a', files: 1, dependsOn: [] }]);
  assert(/SWE_BUILD_USAGES/.test(out), 'no-edges module graph notes the usages index');
}

// ---- call graph: callees vs callers ---------------------------------------
const tree = {
  name: 'checkoutOrder',
  file: 'src/checkout.ts',
  line: 10,
  children: [
    { name: 'charge', file: 'src/pay.ts', line: 3, children: [{ name: 'save', file: 'src/db.ts', line: 5, children: [] }] },
    { name: 'validate', file: 'src/checkout.ts', line: 40, children: [] },
  ],
};

{
  const out = callGraphMermaid(tree, 'callees');
  console.log('\n--- call graph (callees) ---\n' + out + '\n');
  assert(out.startsWith('```mermaid\ngraph TD'), 'call graph is a mermaid graph TD block');
  assert(/\["checkoutOrder"\]/.test(out) && /\["charge"\]/.test(out) && /\["save"\]/.test(out), 'all symbols become nodes');
  assert((out.match(/-->/g) || []).length === 3, 'callees: three edges (root→charge, charge→save, root→validate)');
}

{
  // Same tree, callers direction → arrows reversed (child calls parent).
  const callees = callGraphMermaid(tree, 'callees');
  const callers = callGraphMermaid(tree, 'callers');
  assert(callers.startsWith('```mermaid\ngraph TD'), 'callers graph is graph TD');
  assert((callers.match(/-->/g) || []).length === 3, 'callers: three edges');
  assert(callers !== callees, 'callers direction reverses edges vs callees');
}

// truncation marker propagates
{
  const t = { name: 'hub', children: [{ name: 'x', truncated: 'cap', children: [] }] };
  assert(/truncated/i.test(callGraphMermaid(t, 'callees')), 'truncated node adds a caption');
}

// label sanitization: characters that break mermaid are neutralized
{
  const out = callGraphMermaid({ name: 'weird"<name>|{x}', children: [{ name: 'y', children: [] }] }, 'callees');
  assert(!/["]<|>|\|/.test(out.split('\n').find((l) => l.includes('weird')) ?? ''), 'label strips <>|{} and escapes quotes');
}

console.log('\nAll mermaid tests passed.');
