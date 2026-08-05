import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { detectStandards } from '../standards/registry.js';

// Surfaces the project's detected standards — framework(s), the PSR-4 namespace↔path
// map (with where each mapping came from), and the enforced coding standard — read
// from the ecosystem's own artifacts (Composer's generated files, root composer.json,
// Drupal *.info.yml, .foundry/standards.json). Deterministic, offline, no index.
export function registerProjectStandardsTool(server: McpServer, workspaceRoot: string): void {
  server.tool(
    'project_standards',
    'Report the project\'s detected standards: framework(s) (Drupal/Symfony/Laravel), ' +
      'the PSR-4 namespace→directory map, and the enforced coding standard. Read from ' +
      "the ecosystem's own files (Composer's generated vendor artifacts, composer.json, " +
      'Drupal *.info.yml, and .foundry/standards.json) — not guessed. Use it on a PHP/' +
      'Drupal repo to learn how namespaces map to folders (so you can turn a ' +
      'fully-qualified class name into a file — foundry_readFile also accepts an FQCN) ' +
      'and what conventions the project follows. Deterministic, offline, no index.',
    {
      namespaces: z
        .boolean()
        .optional()
        .describe('Include the full PSR-4 map (default true). Set false for just framework + coding standard.'),
    },
    async ({ namespaces }) => {
      const std = detectStandards(workspaceRoot);
      const showNs = namespaces !== false;

      const lines: string[] = [];
      lines.push(
        `Frameworks: ${std.frameworks.length ? std.frameworks.join(', ') : '(none detected)'}`,
      );
      lines.push(
        `Coding standards: ${std.codingStandards.length ? std.codingStandards.join(', ') : '(none declared)'}`,
      );
      if (showNs) {
        if (std.psr4.length) {
          lines.push(`\nPSR-4 namespace → directory (${std.psr4.length}):`);
          for (const e of std.psr4.slice(0, 60)) lines.push(`  ${e.prefix} → ${e.dir}/  [${e.source}]`);
          if (std.psr4.length > 60) lines.push(`  … and ${std.psr4.length - 60} more.`);
        } else {
          lines.push('\nPSR-4: (none — no composer/Drupal/.foundry sources found).');
        }
        if (std.classMap.length) lines.push(`\nExact class map available: ${std.classMap.length} classes.`);
      }
      if (std.notes.length) lines.push(`\nSources: ${std.notes.join('; ')}`);

      if (!std.frameworks.length && !std.psr4.length && !std.codingStandards.length) {
        lines.length = 0;
        lines.push(
          'No project standards detected. This is expected for non-PHP projects, or a ' +
            'PHP project without composer.json / vendor. You can declare standards in ' +
            '.foundry/standards.json.',
        );
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          frameworks: std.frameworks,
          codingStandards: std.codingStandards,
          psr4: showNs ? std.psr4 : undefined,
          classMapCount: std.classMap.length,
          notes: std.notes,
        },
      };
    },
  );
}
