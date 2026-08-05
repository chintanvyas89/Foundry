import type { ConfigSummarizer } from '../types.js';
import { genericSummarizer } from './generic.js';

// The CORE summarizer chain — always active, format-agnostic, works for any
// project. `generic` is the catch-all and must stay last. Type-specific readers
// (e.g. Drupal) live in ../packs and are enabled per-project on top of this.
export const CORE_SUMMARIZERS: ConfigSummarizer[] = [genericSummarizer];
