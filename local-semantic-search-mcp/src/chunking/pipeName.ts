import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';

// NOTE: this logic is duplicated in the companion extension
// (lsp-bridge-extension/src/pipeName.ts) — both sides must compute the same
// path independently, with no coordination file exchanged. Keep them in
// sync if this changes. Not extracted to a shared npm package: the MCP
// server and the VS Code extension are two separately-installed projects,
// and sharing a package would couple their release cycles for a pilot-scale
// bridge that's a few lines of logic.
export function getPipePath(workspaceRoot: string): string {
  const hash = createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 16);
  if (platform === 'win32') {
    return `\\\\.\\pipe\\swe-search-${hash}`;
  }
  // A Unix domain socket file. Restricted to the current user at listen
  // time (see extension.ts) — no other local account should reach it.
  return join(tmpdir(), `swe-search-${hash}.sock`);
}
