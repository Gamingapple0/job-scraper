import type {
  AdapterContext,
  RawJob,
  RunOptions,
  SearchQuery,
  SourceAdapter,
} from '../core/types.js';
import { pick, asString, asBool } from './util.js';
import { stripHtml } from '../core/normalize.js';

/**
 * Seek (seek.com.au).
 *
 * Seek's own React frontend calls a private JSON search API. No browser, no
 * CSS selectors, no LLM parsing: the response is already structured.
 *
 * The endpoint path and parameter names are NOT part of a public contract and
 * do change. Both live in config (sources.seek.*) so you can repoint them
 * without touching this file. See README "Confirming the Seek endpoint".
 */

interface SeekSettings {
  searchEndpoint: string;
  jobDetailUrl: string;
  siteKey: string;
  sourcesystem: string;
  locale: string;
  pageSize: number;
  sortMode: string;
  maxRequestsPerRun: number;
  extraParams: Record<string, string>;
}

const DEFAULTS: SeekSettings = {
  searchEndpoint: 'https://www.seek.com.au/api/jobsearch/v5/search',
  // Note: this is deliberately NOT www.seek.com.au. That domain's search API
  // (see searchEndpoint below) answers plain requests fine, but its job
  // detail *pages* return HTTP 403 to a non-browser request. au.seek.com
  // serves the same page and is not blocked. Confirmed against a real
  // browser network capture on 2026-09-05 — see README "Confirming the Seek
  // endpoint" if this starts failing again.
  jobDetailUrl: 'https://au.seek.com/job/{id}',
  siteKey: 'AU-Main',
  sourcesystem: 'houston',
  locale: 'en-AU',
  pageSize: 22,
  sortMode: 'ListedDate',
  maxRequestsPerRun: 200,
  extraParams: {},
};

interface SeekSearchResponse {
  data?: unknown[];
  totalCount?: number;
  [k: string]: unknown;
}

export function createSeekAdapter(ctx: AdapterContext): SourceAdapter {
  const s: SeekSettings = { ...DEFAULTS, ...(ctx.settings as Partial<SeekSettings>) };
  // Counts detail-fetch misses within this adapter instance (one run), so a
  // structurally broken detail page is loud early and quiet after that
  // instead of spamming the log once per job.
  let detailMisses = 0;

  function searchUrl(query: SearchQuery, page: number): string {
    const u = new URL(s.searchEndpoint);
    const params: Record<string, string> = {
      siteKey: s.siteKey,
      sourcesystem: s.sourcesystem,
      locale: s.locale,
      keywords: query.query,
      where: query.location,
      page: String(page),
      pageSize: String(s.pageSize),
      sortmode: s.sortMode,
      ...s.extraParams,
    };
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    return u.toString();
  }

  /** A plausible human-facing URL for the same search, used as Referer. */
  function refererFor(query: SearchQuery): string {
    const kw = query.query.trim().toLowerCase().replace(/\s+/g, '-');
    const loc = query.location.trim().toLowerCase().replace(/\s+/g, '-');
    return `https://www.seek.com.au/${encodeURIComponent(kw)}-jobs/in-${encodeURIComponent(loc)}`;
  }

  function headers(query: SearchQuery): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      Referer: refererFor(query),
      Origin: 'https://www.seek.com.au',
      'seek-request-brand': 'seek',
      'seek-request-country': 'AU',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    };
  }

  function mapJob(item: unknown): RawJob | undefined {
    if (!item || typeof item !== 'object') return undefined;
    const o = item as Record<string, unknown>;

    const sourceId = asString(pick(o, ['id', 'jobId', 'solMetadata.jobId']));
    const title = asString(pick(o, ['title', 'jobTitle']));
    if (!sourceId || !title) return undefined;

    const company =
      asString(
        pick(o, [
          'advertiser.description',
          'advertiser.name',
          'companyName',
          'company.name',
          'branding.advertiser.name',
        ]),
      ) || 'Unknown';

    // Real shape: locations[0].label is already the full "Suburb, City STATE"
    // string (e.g. "Surry Hills, Sydney NSW"). Try that first; only fall back
    // to stitching location + area together for older/alternate shapes that
    // split it into two fields (a bare pick() would grab "location" alone
    // before ever trying the join, since it stops at the first truthy hit).
    const locationRaw =
      asString(pick(o, ['locations.0.label'])) ||
      [
        asString(pick(o, ['location', 'jobLocation.label', 'locationLabel'])),
        asString(pick(o, ['area', 'suburb'])),
      ]
        .filter(Boolean)
        .join(', ') ||
      asString(pick(o, ['displayLocation'])) ||
      '';

    const workType =
      asString(pick(o, ['workType', 'workTypes.0'])) ||
      (Array.isArray(o['workTypes']) ? String((o['workTypes'] as unknown[])[0] ?? '') : '');

    const teaserParts = [
      asString(pick(o, ['teaser'])),
      ...(Array.isArray(o['bulletPoints']) ? (o['bulletPoints'] as unknown[]).map(String) : []),
    ].filter(Boolean);

    const remoteHint =
      asBool(pick(o, ['isRemote', 'workArrangement.remote'])) ||
      /remote|work from home|hybrid/i.test(
        JSON.stringify(o['workArrangements'] ?? o['workArrangement'] ?? ''),
      );

    const job: RawJob = {
      sourceId,
      url: s.jobDetailUrl.replace('{id}', sourceId),
      title,
      company,
      locationRaw,
      raw: o,
    };

    const salaryRaw = asString(pick(o, ['salary', 'salaryLabel', 'salaryRange']));
    if (salaryRaw) job.salaryRaw = salaryRaw;
    const postedAtRaw = asString(pick(o, ['listingDate', 'listingDateDisplay', 'datePosted']));
    if (postedAtRaw) job.postedAtRaw = postedAtRaw;
    if (workType) job.employmentTypeRaw = workType;
    if (teaserParts.length) job.teaser = teaserParts.join(' · ');
    const category = asString(
      pick(o, [
        // Real shape: classifications[0].subclassification.description (lowercase c)
        'classifications.0.subclassification.description',
        'classifications.0.classification.description',
        // Older/alternate shapes seen in the wild, kept as fallbacks.
        'subClassification.description',
        'classification.description',
        'category',
      ]),
    );
    if (category) job.category = category;
    if (remoteHint) job.remoteHint = true;

    return job;
  }

  return {
    name: 'seek',

    async *search(query: SearchQuery, opts: RunOptions): AsyncGenerator<RawJob, void, void> {
      const maxPages = Math.min(opts.maxPages, Math.ceil(s.maxRequestsPerRun / 1));
      let total: number | undefined;
      let emitted = 0;

      for (let page = 1; page <= maxPages; page++) {
        const url = searchUrl(query, page);
        const body = await ctx.http.getJson<SeekSearchResponse>(url, { headers: headers(query) });

        const rows = Array.isArray(body.data) ? body.data : [];
        if (typeof body.totalCount === 'number') total = body.totalCount;

        if (rows.length === 0) {
          ctx.logger.debug('seek: empty page, stopping', { page });
          if (page === 1) {
            ctx.logger.warn(
              'seek: page 1 returned no rows. The endpoint or its parameters may have changed. ' +
                'Run `npm run discover -- --source seek` and inspect data/.cache/seek-sample.json.',
            );
          }
          return;
        }

        let mappedOnPage = 0;
        for (const row of rows) {
          const job = mapJob(row);
          if (!job) continue;
          mappedOnPage++;
          emitted++;
          yield job;
        }

        if (mappedOnPage === 0) {
          ctx.logger.warn('seek: rows returned but none could be mapped; field names likely changed');
          return;
        }

        if (total !== undefined && emitted >= total) return;
        if (rows.length < s.pageSize) return;
      }
    },

    async fetchDetail(job: RawJob): Promise<Partial<RawJob>> {
      const html = await ctx.http.getText(job.url, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      const out: Partial<RawJob> = {};

      // Primary source: the visible ad body itself, marked
      // data-automation="jobAdDetails". This is what a real user sees, so
      // unlike JSON-LD or embedded framework state, it can't go stale
      // without the page itself visibly breaking for everyone. Confirmed
      // against a real page capture on 2026-09-05.
      const adHtml = extractJobAdHtml(html);
      if (adHtml) {
        const desc = stripHtml(adHtml);
        if (desc) out.description = desc;
      }

      // JSON-LD, when present, still carries clean structured fields the
      // visible HTML doesn't (employmentType, datePosted), so check it
      // regardless of whether the description above was found.
      const posting = extractJobPostingLd(html);
      if (posting) {
        if (!out.description) {
          const desc = asString(posting['description']);
          if (desc) out.description = desc;
        }
        const employmentType = asString(posting['employmentType']);
        if (employmentType) out.employmentTypeRaw = employmentType;
        const datePosted = asString(posting['datePosted']);
        if (datePosted && !job.postedAtRaw) out.postedAtRaw = datePosted;
      }

      // Last resort: the page's embedded Next.js state, in case a redesign
      // removes both of the above.
      if (!out.description) {
        const desc = extractNextDataDescription(html, job.sourceId);
        if (desc) out.description = desc;
      }

      if (!out.description) {
        detailMisses++;
        if (detailMisses <= 3) {
          ctx.logger.warn(
            `seek: could not find a description on ${job.url}. ` +
              `Neither a JSON-LD JobPosting nor __NEXT_DATA__ contained one. ` +
              `First 400 chars of the page: ${html.slice(0, 400).replace(/\s+/g, ' ')}`,
          );
        } else if (detailMisses === 4) {
          ctx.logger.warn('seek: further description misses this run will be logged at debug level only');
        } else {
          ctx.logger.debug('seek: description miss', { url: job.url });
        }
      }

      return out;
    },

    async discover(query: SearchQuery): Promise<unknown> {
      const url = searchUrl(query, 1);
      ctx.logger.info(`seek: requesting ${url}`);
      return ctx.http.getJson(url, { headers: headers(query), noCache: true });
    },
  };
}

/** Pull the JobPosting object out of the page's JSON-LD blocks. */
export function extractJobPostingLd(html: string): Record<string, unknown> | undefined {
  const rx = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html)) !== null) {
    const chunk = m[1];
    if (!chunk) continue;
    try {
      const parsed = JSON.parse(chunk) as unknown;
      const found = findJobPosting(parsed);
      if (found) return found;
    } catch {
      // Malformed block, try the next one.
    }
  }
  return undefined;
}

/**
 * Extract the raw HTML of the visible job ad body.
 *
 * The container is marked `data-automation="jobAdDetails"` and holds
 * ordinary hand-authored markup (h2/p/ul/li/strong/br) — this is literally
 * what the advertiser typed, rendered. Because it's what every visitor sees,
 * it can't silently drift out of sync the way an SEO-only JSON-LD block or a
 * framework's internal state object can.
 *
 * A plain "find the closing </div>" won't work since the ad body itself
 * contains nested <div> wrappers, so this walks tag-by-tag tracking depth to
 * find the one that actually matches the opening tag.
 */
export function extractJobAdHtml(html: string): string | undefined {
  const markerIdx = html.search(/data-automation=["']jobAdDetails["']/i);
  if (markerIdx === -1) return undefined;

  const divStart = html.lastIndexOf('<div', markerIdx);
  if (divStart === -1) return undefined;

  const tagRe = /<div\b|<\/div\s*>/gi;
  tagRe.lastIndex = divStart;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].toLowerCase().startsWith('<div')) depth++;
    else depth--;
    if (depth === 0) return html.slice(divStart, tagRe.lastIndex);
  }
  return undefined; // unbalanced markup; give up rather than return a truncated ad
}

/**
 * Fallback for when the page has no JSON-LD JobPosting (or it lacks a
 * description). Seek's frontend is Next.js, and server-rendered pages embed
 * their full page-load payload in a <script id="__NEXT_DATA__"> block, so
 * the job's description is usually in there even when the SEO-oriented
 * JSON-LD block is missing or thin.
 *
 * Rather than hard-coding one exact path (which breaks on any Next.js
 * build/route change), this walks the whole tree looking for a "content" or
 * "description" string that is clearly job-ad prose: long, and ideally
 * co-located with this job's id or something close to its title.
 */
export function extractNextDataDescription(html: string, sourceId: string): string | undefined {
  const m = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m?.[1]) return undefined;

  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return undefined;
  }

  let best: string | undefined;
  let bestNearId = false;

  const visit = (node: unknown, sawThisId: boolean): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, sawThisId);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const obj = node as Record<string, unknown>;
    const idHere =
      sawThisId ||
      String(obj['id'] ?? '') === sourceId ||
      String(obj['jobId'] ?? '') === sourceId ||
      String(obj['adId'] ?? '') === sourceId;

    for (const key of ['content', 'description', 'jobAdDetails', 'adDetails']) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 200 && /<[a-z][\s\S]*>|\. /i.test(v)) {
        // Prefer a match confirmed to belong to this job id; otherwise take
        // the first plausible one found, in case id fields don't line up.
        if (idHere && !bestNearId) {
          best = v;
          bestNearId = true;
        } else if (!best) {
          best = v;
        }
      }
    }

    for (const v of Object.values(obj)) visit(v, idHere);
  };

  visit(data, false);
  return best;
}

function findJobPosting(node: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findJobPosting(n);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (String(o['@type'] ?? '').toLowerCase() === 'jobposting') return o;
    for (const v of Object.values(o)) {
      const hit = findJobPosting(v);
      if (hit) return hit;
    }
  }
  return undefined;
}
