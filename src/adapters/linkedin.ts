import type {
  AdapterContext,
  RawJob,
  RunOptions,
  SearchQuery,
  SourceAdapter,
} from '../core/types.js';
import { asString } from './util.js';
import { stripHtml } from '../core/normalize.js';
import { extractJobPostingLd } from './seek.js';

/**
 * LinkedIn (linkedin.com), logged-out guest endpoints only.
 *
 * LinkedIn's own frontend calls a public "guest" search endpoint when a
 * results page loads more cards (infinite scroll). It carries no account
 * risk to call directly, unlike automating a signed-in session, which is
 * what gets accounts restricted and LinkedIn detects. The endpoint returns
 * an HTML fragment of <li> cards, not JSON — see docs/adding-a-source.md
 * "LinkedIn, when you get to it" for the research this is built from.
 *
 * The endpoint paths, CSS class names and query parameters are NOT part of
 * a public contract and can change without notice. All of them live in
 * config (sources.linkedin.*) so they can be repointed without touching
 * this file. If this adapter goes quiet, run
 * `npm run discover -- --source linkedin` and diff the saved HTML against
 * the class names referenced below.
 */

interface LinkedInSettings {
  searchEndpoint: string;
  detailEndpoint: string;
  publicJobUrl: string;
  pageSize: number;
  timePosted: string;
  maxRequestsPerRun: number;
  maxStart: number;
  extraParams: Record<string, string>;
}

const DEFAULTS: LinkedInSettings = {
  searchEndpoint: 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search',
  detailEndpoint: 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}',
  publicJobUrl: 'https://www.linkedin.com/jobs/view/{id}',
  pageSize: 25,
  // Last 24 hours, which is what a daily run wants. LinkedIn's own param name.
  timePosted: 'r86400',
  maxRequestsPerRun: 100,
  // `start` stops returning new results somewhere near 1000 regardless of
  // how many postings actually match; stop asking past that.
  maxStart: 1000,
  extraParams: {},
};

export function createLinkedInAdapter(ctx: AdapterContext): SourceAdapter {
  const s: LinkedInSettings = { ...DEFAULTS, ...(ctx.settings as Partial<LinkedInSettings>) };
  // Same reasoning as Seek's detailMisses: loud early, quiet after that,
  // instead of spamming the log once per job when the markup has moved.
  let detailMisses = 0;

  function searchUrl(query: SearchQuery, start: number): string {
    const u = new URL(s.searchEndpoint);
    const params: Record<string, string> = {
      keywords: query.query,
      location: query.location,
      f_TPR: s.timePosted,
      start: String(start),
      ...s.extraParams,
    };
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    return u.toString();
  }

  /** A plausible human-facing search URL for the same query, used as Referer. */
  function refererFor(query: SearchQuery): string {
    const u = new URL('https://www.linkedin.com/jobs/search');
    u.searchParams.set('keywords', query.query);
    u.searchParams.set('location', query.location);
    return u.toString();
  }

  function headers(query: SearchQuery): Record<string, string> {
    return {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: refererFor(query),
      'X-Requested-With': 'XMLHttpRequest',
    };
  }

  function mapCard(card: string): RawJob | undefined {
    const urn = /data-entity-urn=["']urn:li:jobPosting:(\d+)["']/i.exec(card)?.[1];
    const hrefMatch = /href=["']([^"']*linkedin\.com\/jobs\/view\/[^"']+)["']/i.exec(card)?.[1];
    const hrefId = hrefMatch ? /(\d+)\/?$/.exec(hrefMatch.split('?')[0] ?? '')?.[1] : undefined;
    const sourceId = urn ?? hrefId;

    const title = fieldText(card, 'h3', 'base-search-card__title');
    if (!sourceId || !title) return undefined;

    const company = fieldText(card, 'h4', 'base-search-card__subtitle') || 'Unknown';
    const locationRaw = fieldText(card, 'span', 'job-search-card__location') || '';
    const workplaceType = fieldText(card, 'span', 'job-search-card__workplace-type') || '';

    const timeTag = openTag(card, 'time', 'job-search-card__listdate');
    const postedAtRaw =
      (timeTag && /datetime=["']([^"']*)["']/i.exec(timeTag)?.[1]) ||
      fieldText(card, 'time', 'job-search-card__listdate');

    const salaryRaw = fieldText(card, 'span', 'job-search-card__salary-info');

    const job: RawJob = {
      sourceId,
      url: s.publicJobUrl.replace('{id}', sourceId),
      title,
      company,
      locationRaw,
      raw: card,
    };
    if (salaryRaw) job.salaryRaw = salaryRaw;
    if (postedAtRaw) job.postedAtRaw = postedAtRaw;
    if (/remote|hybrid|work from home/i.test(`${locationRaw} ${workplaceType}`)) job.remoteHint = true;

    return job;
  }

  return {
    name: 'linkedin',

    async *search(query: SearchQuery, opts: RunOptions): AsyncGenerator<RawJob, void, void> {
      const maxPages = Math.min(opts.maxPages, Math.ceil(s.maxRequestsPerRun / 1));

      for (let page = 0; page < maxPages; page++) {
        const start = page * s.pageSize;
        if (start > s.maxStart) {
          ctx.logger.debug('linkedin: reached maxStart, stopping', { start });
          return;
        }

        const url = searchUrl(query, start);
        const html = await ctx.http.getText(url, { headers: headers(query) });
        const cards = extractJobCards(html);

        if (cards.length === 0) {
          ctx.logger.debug('linkedin: empty page, stopping', { start });
          if (page === 0) {
            ctx.logger.warn(
              'linkedin: first page returned no cards. The endpoint or its markup may have changed. ' +
                'Run `npm run discover -- --source linkedin` and inspect data/.cache/linkedin-sample.json.',
            );
          }
          return;
        }

        let mappedOnPage = 0;
        for (const card of cards) {
          const job = mapCard(card);
          if (!job) continue;
          mappedOnPage++;
          yield job;
        }

        if (mappedOnPage === 0) {
          ctx.logger.warn('linkedin: cards returned but none could be mapped; markup likely changed');
          return;
        }

        if (cards.length < s.pageSize) return;
      }
    },

    async fetchDetail(job: RawJob): Promise<Partial<RawJob>> {
      const url = s.detailEndpoint.replace('{id}', job.sourceId);
      const html = await ctx.http.getText(url, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      const out: Partial<RawJob> = {};

      // Primary source: the visible description body, same reasoning as
      // Seek's fetchDetail — what a real user sees can't drift silently.
      const descHtml = extractDescriptionHtml(html);
      if (descHtml) {
        const desc = stripHtml(descHtml);
        if (desc) out.description = desc;
      }

      const criteria = extractJobCriteria(html);
      const employmentType = criteria['employment type'];
      if (employmentType) out.employmentTypeRaw = employmentType;

      // Fallback: JSON-LD JobPosting block, when present. Reused from the
      // Seek adapter rather than reimplemented — the search is generic.
      if (!out.description) {
        const posting = extractJobPostingLd(html);
        if (posting) {
          const desc = asString(posting['description']);
          if (desc) out.description = stripHtml(desc) ?? desc;
        }
      }

      if (!out.description) {
        detailMisses++;
        if (detailMisses <= 3) {
          ctx.logger.warn(
            `linkedin: could not find a description on ${url}. Neither the ` +
              `show-more-less-html__markup block nor a JSON-LD JobPosting contained one. ` +
              `First 400 chars of the page: ${html.slice(0, 400).replace(/\s+/g, ' ')}`,
          );
        } else if (detailMisses === 4) {
          ctx.logger.warn('linkedin: further description misses this run will be logged at debug level only');
        } else {
          ctx.logger.debug('linkedin: description miss', { url });
        }
      }

      return out;
    },

    async discover(query: SearchQuery): Promise<unknown> {
      const url = searchUrl(query, 0);
      ctx.logger.info(`linkedin: requesting ${url}`);
      const html = await ctx.http.getText(url, { headers: headers(query), noCache: true });
      return { url, html };
    },
  };
}

/* ------------------------------------------------------------- HTML utils */

/**
 * Balanced-depth tag extraction, same technique as Seek's extractJobAdHtml:
 * a plain "find the closing tag" breaks the moment the element nests another
 * copy of itself (an <li> inside an <li>, a <div> inside a <div>), so this
 * walks tag-by-tag tracking depth to find the one that actually closes the
 * opening tag it started at.
 */
function extractBalancedTag(
  html: string,
  tagName: string,
  fromIndex = 0,
): { html: string; end: number } | undefined {
  const openRe = new RegExp(`<${tagName}\\b`, 'i');
  const rel = openRe.exec(html.slice(fromIndex));
  if (!rel) return undefined;
  const start = fromIndex + rel.index;

  const tagRe = new RegExp(`<${tagName}\\b|<\\/${tagName}\\s*>`, 'gi');
  tagRe.lastIndex = start;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].toLowerCase().startsWith(`<${tagName}`)) depth++;
    else depth--;
    if (depth === 0) return { html: html.slice(start, tagRe.lastIndex), end: tagRe.lastIndex };
  }
  return undefined; // unbalanced markup; give up rather than return a truncated card
}

/** Split a results fragment into its individual job cards. */
export function extractJobCards(html: string): string[] {
  const cards: string[] = [];
  let idx = 0;
  while (idx < html.length) {
    const found = extractBalancedTag(html, 'li', idx);
    if (!found) break;
    cards.push(found.html);
    idx = found.end;
  }
  return cards;
}

/** Extract the full opening tag (all its attributes) matching a class hint. */
function openTag(html: string, tagName: string, classHint: string): string | undefined {
  const re = new RegExp(`<${tagName}\\b[^>]*class=["'][^"']*${classHint}[^"']*["'][^>]*>`, 'i');
  return re.exec(html)?.[0];
}

/** Extract and clean the inner text of the first tag matching a class hint. */
function fieldText(html: string, tagName: string, classHint: string): string | undefined {
  const re = new RegExp(
    `<${tagName}\\b[^>]*class=["'][^"']*${classHint}[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    'i',
  );
  const m = re.exec(html);
  return m?.[1] ? stripHtml(m[1]) : undefined;
}

/**
 * Extract the raw HTML of the visible job description body on a detail
 * fragment. Marked `show-more-less-html__markup` in LinkedIn's guest markup.
 */
export function extractDescriptionHtml(html: string): string | undefined {
  const markerIdx = html.search(/class=["'][^"']*show-more-less-html__markup[^"']*["']/i);
  if (markerIdx === -1) return undefined;
  const divStart = html.lastIndexOf('<div', markerIdx);
  if (divStart === -1) return undefined;
  return extractBalancedTag(html, 'div', divStart)?.html;
}

/**
 * The detail fragment's "criteria" list (employment type, seniority level,
 * job function, industries) as label -> value, lowercased labels.
 */
export function extractJobCriteria(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re =
    /<h3[^>]*class=["'][^"']*description__job-criteria-subheader[^"']*["'][^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*class=["'][^"']*description__job-criteria-text[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const label = stripHtml(m[1])?.toLowerCase();
    const value = stripHtml(m[2]);
    if (label && value) out[label] = value;
  }
  return out;
}
