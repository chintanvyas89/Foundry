import type { StandardReader } from '../types.js';
import { foundryJsonReader } from './foundryJson.js';
import { composerVendorReader } from './composerVendor.js';
import { drupalInfoReader } from './drupalInfo.js';
import { composerJsonReader } from './composerJson.js';
import { codingStandardReader } from './codingStandard.js';

// Built-in readers, ordered MOST-AUTHORITATIVE FIRST (the registry keeps the first
// writer of a given PSR-4 prefix). To contribute a new standard/ecosystem, add a
// reader file next to these and one line here.
export const READERS: StandardReader[] = [
  foundryJsonReader, // explicit project override wins
  composerVendorReader, // Composer's generated, authoritative artifacts
  drupalInfoReader, // Drupal runtime module namespaces (not in Composer psr-4)
  composerJsonReader, // root composer.json (fallback when vendor/ absent)
  codingStandardReader, // enforced coding standard (no psr-4)
];
