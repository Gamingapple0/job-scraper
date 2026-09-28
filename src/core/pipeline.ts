import type {
  Job,
  LoggerLike,
  RunOptions,
  RunStats,
  SearchQuery,
  SourceAdapter,
} from './types.js';
import type { Store, RunHistoryEntry } from './store.js';
import { toJob, daysSince } from './normalize.js';
import { BlockedError } from './http.js';

export interface RunContext {
  store: Store;
  logger: LoggerLike;
  history: RunHistoryEntry[];
  sanityFloorRatio: number;
}

export interface RunResult {
  stats: RunStats;
  created: Job[];
  updated: Job[];
  seenIds: string[];
}

/**
 * Runs one query against one adapter.
 *
 * Guarantees:
 *  - a per-job parse failure never kills the run
 *  - a block (403/429) stops that source immediately instead of grinding
 *  - a suspiciously empty result is reported as not-ok rather than silently
 *    overwriting a healthy dataset with nothing
 */
export async function runSearch(
  adapter: SourceAdapter,
  query: SearchQuery,
  opts: RunOptions,
  ctx: RunContext,
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const created: Job[] = [];
  const updated: Job[] = [];
  const seenIds: string[] = [];
  let fetched = 0;
  let merged = 0;
  let skippedTooOld = 0;
  let errors = 0;
  let blocked = false;

  ctx.logger.info(`[${adapter.name}] "${query.query}" @ ${query.location}`);

  try {
    for await (const raw of adapter.search(query, opts)) {
      fetched++;
      try {
        let enriched = raw;
        if (opts.detail && adapter.fetchDetail && !raw.description) {
          try {
            const extra = await adapter.fetchDetail(raw);
            enriched = { ...raw, ...extra };
          } catch (err) {
            // Visible at the default log level on purpose: a description
            // silently never arriving is exactly the failure mode that is
            // easy to miss otherwise.
            ctx.logger.warn('detail fetch failed, keeping card data without a description', {
              url: raw.url,
              error: String(err),
            });
          }
        }

        const job = toJob(enriched, adapter.name, query.query);

        const maxAge = opts.maxAgeDays;
        if (maxAge !== undefined) {
          const age = daysSince(job.postedAt);
          if (age !== undefined && age > maxAge) {
            skippedTooOld++;
            continue;
          }
        }

        if (opts.dryRun) {
          created.push(job);
          seenIds.push(job.id);
          continue;
        }

        const res = ctx.store.upsert(job);
        seenIds.push(res.job.id);
        if (res.status === 'new') created.push(res.job);
        else if (res.status === 'merged') {
          merged++;
          updated.push(res.job);
        } else updated.push(res.job);
      } catch (err) {
        errors++;
        ctx.logger.warn('failed to process a job, continuing', { error: String(err) });
        if (errors > 25) throw new Error('Too many per-job failures; parser is probably stale');
      }
    }
  } catch (err) {
    errors++;
    if (err instanceof BlockedError) {
      blocked = true;
      ctx.logger.error(`[${adapter.name}] blocked, stopping this source for the run`, {
        status: err.status,
      });
    } else {
      ctx.logger.error(`[${adapter.name}] run aborted`, { error: String(err) });
    }
  }

  const finishedAt = new Date().toISOString();
  const expected = expectedFetchCount(ctx.history, adapter.name, query.query, query.location);
  let ok = !blocked && errors === 0;
  let note: string | undefined;

  if (expected !== undefined && fetched < expected * ctx.sanityFloorRatio) {
    ok = false;
    note = `Fetched ${fetched}, recent average was ${expected.toFixed(0)}. Parser or endpoint may be stale.`;
    ctx.logger.error(`[${adapter.name}] sanity check failed`, { fetched, expected });
  }

  const stats: RunStats = {
    source: adapter.name,
    query: query.query,
    location: query.location,
    fetched,
    created: created.length,
    updated: updated.length,
    merged,
    skippedTooOld,
    errors,
    startedAt,
    finishedAt,
    ok,
  };
  if (note) stats.note = note;

  ctx.logger.info(
    `[${adapter.name}] done: ${fetched} fetched, ${created.length} new, ${updated.length} updated` +
      (skippedTooOld ? `, ${skippedTooOld} too old` : ''),
  );

  return { stats, created, updated, seenIds };
}

/** Mean fetched count of the last 3 runs of this source+query, if we have them. */
export function expectedFetchCount(
  history: RunHistoryEntry[],
  source: string,
  query: string,
  location: string,
): number | undefined {
  // Different locations sharing the same query text (e.g. every AU-regional
  // Seek search reuses "full stack developer java spring react") are
  // different job markets with different real volumes — must not be pooled
  // into one rolling average or the smaller market gets flagged as broken.
  const rows = history
    .filter((h) => h.source === source && h.query === query && h.location === location)
    .slice(-3);
  if (rows.length < 3) return undefined;
  const total = rows.reduce((a, r) => a + r.fetched, 0);
  return total / rows.length;
}
