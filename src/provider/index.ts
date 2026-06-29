/**
 * Provider registry and selector (D-03, D-04).
 *
 * getProvider() is the single dispatch point for ReviewProvider instances.
 * The pipeline calls this once and interacts only with the ReviewProvider interface --
 * no direct imports of concrete provider modules anywhere in the worker/queue/poster.
 *
 * To add a provider (e.g. CodexProvider for v2):
 *   1. Implement ReviewProvider in src/provider/codex.ts.
 *   2. Add a branch here: if (name === 'codex') return new CodexProvider();
 *   No pipeline, webhook, queue, or poster changes required.
 */

import type { ReviewProvider } from './types.js';
import { ClaudeProvider } from './claude.js';

export type { ReviewProvider };
export type { Finding, ParsedOutput, ReviewContext, RawOutput } from './types.js';

/**
 * Return the ReviewProvider for the given provider name.
 * Phase 1 supports only 'claude' (the default).
 */
export function getProvider(providerName = 'claude'): ReviewProvider {
  if (providerName === 'claude') {
    return new ClaudeProvider();
  }
  throw new Error(`Unknown review provider: '${providerName}'. Supported: claude`);
}
