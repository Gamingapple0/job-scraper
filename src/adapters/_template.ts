/**
 * Template for a new job source. Copy to <name>.ts, fill in, register in
 * registry.ts. Delete every comment that no longer applies.
 *
 * Rules that keep the pipeline healthy:
 *  1. Emit RawJob, not Job. Normalization is not your problem.
 *  2. yield as you go. Never buffer a whole run in memory.
 *  3. Every network call goes through ctx.http so it is rate limited, retried
 *     and cached. Never call fetch() directly.
 *  4. Put anything site-specific and changeable (endpoints, selectors, page
 *     size) in config, not in code.
 *  5. Fail loud on a mapping failure. Silent zeroes are the classic scraper
 *     failure mode and the pipeline's sanity check depends on you not
 *     swallowing them.
 */
import type {
  AdapterContext,
  RawJob,
  RunOptions,
  SearchQuery,
  SourceAdapter,
} from '../core/types.js';
import { asString, pick } from './util.js';

interface TemplateSettings {
  searchEndpoint: string;
  pageSize: number;
}

const DEFAULTS: TemplateSettings = {
  searchEndpoint: 'https://example.com/api/jobs',
  pageSize: 25,
};

export function createTemplateAdapter(ctx: AdapterContext): SourceAdapter {
  const s: TemplateSettings = { ...DEFAULTS, ...(ctx.settings as Partial<TemplateSettings>) };

  return {
    name: 'template',

    async *search(query: SearchQuery, opts: RunOptions): AsyncGenerator<RawJob, void, void> {
      for (let page = 0; page < opts.maxPages; page++) {
        const url = `${s.searchEndpoint}?q=${encodeURIComponent(query.query)}&start=${page * s.pageSize}`;

        // JSON source:
        const body = await ctx.http.getJson<{ results?: unknown[] }>(url);
        const rows = body.results ?? [];

        // HTML source: use ctx.http.getText(url) and parse. Prefer an embedded
        // JSON blob (__NEXT_DATA__, window.__APOLLO_STATE__, JSON-LD) over CSS
        // selectors; embedded state survives redesigns that break selectors.

        if (rows.length === 0) return;

        for (const row of rows) {
          const sourceId = asString(pick(row, ['id', 'jobId']));
          const title = asString(pick(row, ['title']));
          if (!sourceId || !title) continue;

          yield {
            sourceId,
            url: `https://example.com/job/${sourceId}`,
            title,
            company: asString(pick(row, ['companyName', 'company.name'])) || 'Unknown',
            locationRaw: asString(pick(row, ['location'])),
            salaryRaw: asString(pick(row, ['salary'])) || undefined,
            postedAtRaw: asString(pick(row, ['postedAt', 'listedAt'])) || undefined,
            raw: row,
          };
        }

        if (rows.length < s.pageSize) return;
      }
    },

    // Optional: a second request per job for the full description.
    // async fetchDetail(job) { ... return { description: html }; },
  };
}
