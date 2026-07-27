// Reusable MCP smoke test: spawns the server as a real MCP client would,
// then runs one or more semantic_search queries and prints the results.
//
//   node scripts/query.mjs <workspaceRoot> "<query>" ["<query2>" ...]
//
// Example:
//   node scripts/query.mjs /home/chintan/projects/Foundry "where is cosine similarity computed"
//
// The first query waits for the background index build to finish (up to 5
// min), so a cold run is slow; later queries are fast.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [workspaceRoot, ...queries] = process.argv.slice(2);
if (!workspaceRoot || queries.length === 0) {
  console.error('Usage: node scripts/query.mjs <workspaceRoot> "<query>" ["<query2>" ...]');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, WORKSPACE_ROOT: workspaceRoot },
  stderr: 'inherit', // surface the server's [swe-search] progress logs
});

const client = new Client({ name: 'query-cli', version: '0.0.1' });
console.error(`\n[query] connecting (workspace: ${workspaceRoot}) ...`);
await client.connect(transport);
console.error('[query] connected — running queries (first one waits for indexing)\n');

for (const q of queries) {
  console.error(`\n===== "${q}" =====`);
  const res = await client.callTool(
    { name: 'semantic_search', arguments: { query: q, topK: 5 } },
    undefined,
    { timeout: 300000 },
  );
  for (const c of res.content) if (c.type === 'text') console.log(c.text);
}

await client.close();
process.exit(0);
