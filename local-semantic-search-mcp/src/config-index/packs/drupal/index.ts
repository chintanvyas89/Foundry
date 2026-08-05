import type { ConfigSummarizer } from '../../types.js';
import { drupalViewSummarizer } from './drupalView.js';
import { drupalFieldSummarizer } from './drupalField.js';
import { drupalDisplaySummarizer } from './drupalDisplay.js';
import { drupalServicesSummarizer } from './drupalServices.js';
import { drupalRoutingSummarizer } from './drupalRouting.js';
import { drupalPermissionsSummarizer } from './drupalPermissions.js';
import { drupalInfoSummarizer } from './drupalInfo.js';

// The Drupal reader pack — type-specific summarizers for Drupal's config formats.
// OFF by default; enabled per-project (auto when Drupal is detected, or via
// `.foundry/config.json` `configReaders: ["drupal"]`). Tried before the generic
// core, so a matching Drupal file gets rich facts and everything else falls
// through to generic.
export const DRUPAL_SUMMARIZERS: ConfigSummarizer[] = [
  drupalViewSummarizer,
  drupalFieldSummarizer,
  drupalDisplaySummarizer,
  drupalServicesSummarizer,
  drupalRoutingSummarizer,
  drupalPermissionsSummarizer,
  drupalInfoSummarizer,
];
