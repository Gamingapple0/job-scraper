import { describe, it, expect } from 'vitest';
import { expectedFetchCount } from '../src/core/pipeline.js';
import type { RunHistoryEntry } from '../src/core/store.js';

function row(query: string, location: string, fetched: number): RunHistoryEntry {
  return { finishedAt: '2026-01-01T00:00:00Z', source: 'seek', query, fetched, created: 0, location };
}

describe('expectedFetchCount', () => {
  it('does not pool two locations that share the same query text', () => {
    // Melbourne runs big, Ballarat runs small — same query string (as config.json
    // does for every AU-regional Seek search). Ballarat's own history must not
    // inherit Melbourne's average, or a genuinely small regional market trips
    // the sanity-floor check every run.
    const history: RunHistoryEntry[] = [
      row('full stack developer java spring react', 'All Melbourne VIC', 60),
      row('full stack developer java spring react', 'All Melbourne VIC', 65),
      row('full stack developer java spring react', 'All Melbourne VIC', 63),
      row('full stack developer java spring react', 'Ballarat & Central Highlands VIC', 1),
      row('full stack developer java spring react', 'Ballarat & Central Highlands VIC', 0),
      row('full stack developer java spring react', 'Ballarat & Central Highlands VIC', 2),
    ];

    expect(
      expectedFetchCount(history, 'seek', 'full stack developer java spring react', 'All Melbourne VIC'),
    ).toBeCloseTo(62.67, 1);

    expect(
      expectedFetchCount(
        history,
        'seek',
        'full stack developer java spring react',
        'Ballarat & Central Highlands VIC',
      ),
    ).toBeCloseTo(1, 5);
  });

  it('returns undefined with fewer than 3 matching rows', () => {
    const history: RunHistoryEntry[] = [row('x', 'y', 5), row('x', 'y', 6)];
    expect(expectedFetchCount(history, 'seek', 'x', 'y')).toBeUndefined();
  });
});
