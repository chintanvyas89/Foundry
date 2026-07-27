import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

// NOTE: duplicated in the MCP server (local-semantic-search-mcp/src/chunking/pipeName.ts).
// Both sides compute the same path independently — no coordination file
// exchanged. Keep both copies in sync if this logic changes.
export function getPipePath(workspaceRoot: string): string {
  const hash = createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 16);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\swe-search-${hash}`;
  }
  return join(tmpdir(), `swe-search-${hash}.sock`);
}
