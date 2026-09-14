import type { AdapterContext, AdapterFactory, SourceAdapter, SourceName } from '../core/types.js';
import { createSeekAdapter } from './seek.js';
import { createLinkedInAdapter } from './linkedin.js';

/**
 * The only place that knows which sources exist.
 *
 * To add a job board: copy _template.ts, implement search(), register it here.
 * Nothing else in the codebase changes.
 */
const FACTORIES: Record<SourceName, AdapterFactory> = {
  seek: createSeekAdapter,
  linkedin: createLinkedInAdapter,
  // indeed:   createIndeedAdapter,     // needs Playwright, see docs/adding-a-source.md
};

export function availableSources(): SourceName[] {
  return Object.keys(FACTORIES);
}

export function hasAdapter(name: string): boolean {
  return name in FACTORIES;
}

export function createAdapter(name: SourceName, ctx: AdapterContext): SourceAdapter {
  const factory = FACTORIES[name];
  if (!factory) {
    throw new Error(
      `Unknown source "${name}". Available: ${availableSources().join(', ') || '(none)'}`,
    );
  }
  return factory(ctx);
}
