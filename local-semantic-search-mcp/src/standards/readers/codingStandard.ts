import type { DetectContext, DetectedStandard, StandardReader } from '../types.js';

// Reports which coding standard the project ENFORCES, from its existing linter
// config — we don't invent one, we read what's declared. phpcs rulesets usually
// `<rule ref="PSR12"/>` or `<rule ref="Drupal"/>`; presence of the other config
// files is noted as-is.

export const codingStandardReader: StandardReader = {
  id: 'coding-standard',
  read(ctx: DetectContext): Partial<DetectedStandard> | null {
    const standards: string[] = [];

    for (const f of ['phpcs.xml', 'phpcs.xml.dist', '.phpcs.xml', '.phpcs.xml.dist']) {
      const raw = ctx.readText(f);
      if (raw == null) continue;
      const refs = [...raw.matchAll(/<rule\s+ref=["']([^"']+)["']/g)].map((m) => m[1]);
      const named = refs.find((r) => /^(PSR12|PSR2|PSR1|Drupal|Squiz|PEAR)$/i.test(r));
      standards.push(named ? `${named} (phpcs: ${f})` : `phpcs (${f})`);
      break;
    }

    if (standards.length === 0) {
      for (const f of ['.php-cs-fixer.php', '.php-cs-fixer.dist.php', '.php_cs', '.php_cs.dist']) {
        if (ctx.exists(f)) {
          standards.push(`php-cs-fixer (${f})`);
          break;
        }
      }
    }
    if (ctx.exists('.editorconfig')) standards.push('.editorconfig');

    return standards.length ? { codingStandards: standards } : null;
  },
};
