import type { VectorStore } from '../storage/store.js';
import { detectStandards } from '../standards/registry.js';
import { resolveVocabulary as resolveDeclaredVocabulary } from '../config-index/settings.js';

// Project-aware query vocabulary — FRAMEWORK-AGNOSTIC by design. Resolves a
// query's phrases to canonical identifiers/synonyms that likely exist in THIS
// project's code, without any framework's terminology hardcoded here. Three
// sources, merged (all optional, all degrade to a no-op cleanly):
//
//   1. Explicit `.foundry/config.json` `vocabulary` map — any project, any
//      domain, no code (see config-index/settings.ts).
//   2. AUTO-DERIVED from the project's OWN already-built config index
//      (whatever framework pack produced it, if any) — a query phrase is
//      cross-referenced against config item ids/labels ALREADY extracted for
//      THIS project, so "content type" resolves to this project's actual
//      content-type machine names. Data-driven: works for any framework, no
//      maintained term list, and stays correct as the project changes.
//   3. An OPT-IN pluggable synonym-pack registry, selected ONLY by the
//      AUTOMATICALLY DETECTED framework (detectStandards — zero config, no
//      user setup). Empty by default: the core planner privileges no
//      framework; packs are an extension point for concept synonyms that
//      can't be derived from data alone (e.g. "content type" ~ "node type"),
//      to be added later by us or by projects — never assumed here.

export interface VocabSynonymPack {
  // Framework name as reported by detectStandards (e.g. "Drupal") this pack
  // applies to. Selected automatically — never configured by the user.
  framework: string;
  // Query phrase (lowercase) -> canonical identifier/synonym variants.
  synonyms: Record<string, string[]>;
}

// No built-in packs ship in this first cut — see the module doc above. Add an
// entry here (or via a future `packs/` folder, mirroring config-index/packs)
// once a concrete, maintained synonym set is worth shipping.
const SYNONYM_PACKS: VocabSynonymPack[] = [];

export function resolveVocabulary(workspaceRoot: string, store: VectorStore, queryText: string): string[] {
  const out = new Set<string>();
  const lowerQuery = queryText.toLowerCase();

  const declared = resolveDeclaredVocabulary(workspaceRoot);
  addPhraseMatches(out, declared, lowerQuery);

  for (const term of deriveFromConfigIndex(store, queryText)) out.add(term);

  try {
    const frameworks = new Set(detectStandards(workspaceRoot).frameworks.map((f) => f.toLowerCase()));
    for (const pack of SYNONYM_PACKS) {
      if (!frameworks.has(pack.framework.toLowerCase())) continue;
      addPhraseMatches(out, pack.synonyms, lowerQuery);
    }
  } catch {
    /* framework detection is best-effort — never block a search on it */
  }

  return [...out];
}

function addPhraseMatches(out: Set<string>, phraseMap: Record<string, string[]>, lowerQuery: string): void {
  for (const [phrase, variants] of Object.entries(phraseMap)) {
    if (phrase && lowerQuery.includes(phrase.toLowerCase())) {
      for (const v of variants) out.add(v);
    }
  }
}

// Cross-reference the query against the project's own already-built config
// index. If a config item's id/label substantially matches, its machine name
// (id) — and the last dotted/underscored segment, often the human-facing part
// (e.g. "node.type.article" -> "article") — become candidate identifiers.
// Returns [] when no config index exists for this project (nothing to derive
// from) — a clean no-op, not an error.
function deriveFromConfigIndex(store: VectorStore, queryText: string): string[] {
  const hits = store.searchConfig(queryText, { cap: 5 });
  const out: string[] = [];
  for (const h of hits) {
    if (!h.id) continue;
    out.push(h.id);
    const lastSegment = h.id.split(/[.:]/).pop();
    if (lastSegment && lastSegment !== h.id) out.push(lastSegment);
  }
  return out;
}
