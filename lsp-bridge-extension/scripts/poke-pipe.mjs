// Manual smoke test for the LSP bridge, no MCP server needed.
// Usage:  node scripts/poke-pipe.mjs <workspaceRoot> <fileToQuery>
// Prints the symbols the bridge returns for one file — the same data the
// MCP server's chunker would use. If it errors with ENOENT/ECONNREFUSED,
// the bridge isn't listening for that workspace root (check the path matches
// the folder open in the Extension Development Host).
import net from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [workspaceRoot, file] = process.argv.slice(2);
if (!workspaceRoot || !file) {
  console.error('Usage: node scripts/poke-pipe.mjs <workspaceRoot> <fileToQuery>');
  process.exit(1);
}

function getPipePath(root) {
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 16);
  if (process.platform === 'win32') return `\\\\.\\pipe\\swe-search-${hash}`;
  return join(tmpdir(), `swe-search-${hash}.sock`);
}

const pipePath = getPipePath(workspaceRoot);
console.error(`[poke] connecting to ${pipePath}`);

const socket = net.createConnection(pipePath, () => {
  socket.write(JSON.stringify({ id: '1', type: 'getSymbols', file }) + '\n');
});
socket.setEncoding('utf-8');
let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk;
  const idx = buffer.indexOf('\n');
  if (idx === -1) return;
  const msg = JSON.parse(buffer.slice(0, idx));
  console.log(JSON.stringify(msg, null, 2));
  socket.end();
});
socket.on('error', (err) => {
  console.error(`[poke] connection failed: ${err.message}`);
  console.error('[poke] is the bridge extension running with this exact folder open?');
  process.exit(1);
});
