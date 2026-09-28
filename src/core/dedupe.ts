import { createHash } from 'node:crypto';
import type { Job, SourceName } from './types.js';

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

export function makeId(source: SourceName, sourceId: string): string {
  return sha1(`${source}:${sourceId}`);
}

/**
 * Company suffixes that carry no identity. "Atlassian Pty Ltd" and
 * "Atlassian" are the same employer; "Senior Engineer" and "Engineer" are not
 * the same job, so seniority words are deliberately kept.
 */
const COMPANY_NOISE =
  /\b(pty\.?|ltd\.?|limited|inc\.?|llc|group|holdings|australia|australian|aus|au|recruitment|recruiting|consulting|technologies|technology|solutions|services|international|global)\b/g;

// "Associate" is a corporate title-tier label that varies by company/platform
// convention (a company's own careers page vs. how a recruiter re-types it
// for LinkedIn), not a real seniority split the way senior/mid/junior are —
// treated as noise so "Associate Software Engineer" on one platform matches
// "Software Engineer" on another. ponytail: this is a judgment call from one
// observed case (nCino); if a genuinely distinct "Associate" tier ever causes
// a false merge, promote it out of noise and handle it explicitly instead.
const TITLE_NOISE =
  /\b(urgent(ly)?|hiring|now|immediate start|apply now|new|hot job|multiple positions|x\d+|associate)\b/g;

export function normalizeCompany(company: string): string {
  return company
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(COMPANY_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // "(Remote)", "(12 month contract)"
    .replace(/[|–—].*$/, ' ') // trailing "| Melbourne", "- Hybrid"
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9+# ]+/g, ' ')
    .replace(TITLE_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeFingerprint(title: string, company: string, city: string): string {
  return sha1(
    [normalizeTitle(title), normalizeCompany(company), (city ?? '').toLowerCase().trim()].join('|'),
  );
}

/** Token-set Jaccard. Used only as the optional third dedupe layer. */
export function titleSimilarity(a: string, b: string): number {
  const A = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const B = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function isProbablySameJob(a: Job, b: Job, threshold = 0.8): boolean {
  if (a.fingerprint === b.fingerprint) return true;
  if (normalizeCompany(a.company) !== normalizeCompany(b.company)) return false;
  return titleSimilarity(a.title, b.title) >= threshold;
}

/**
 * Fold a freshly scraped job into the one already stored.
 * Existing data wins for scrapedAt; richer data wins everywhere else.
 *
 * pipelineStatus, statusHistory and fitReason are deliberately NOT listed
 * below, so `...existing` is what wins for all three: a re-scrape of a job
 * already marked fit_good/fit_bad/tracked/applied must never reset it back
 * to 'scraped' (incoming is always 'scraped', fresh from toJob()). Only the
 * pipeline-status commands are allowed to move it forward.
 */
export function mergeJob(existing: Job, incoming: Job): Job {
  const merged: Job = {
    ...existing,
    lastSeenAt: incoming.lastSeenAt,
    missedRuns: 0,
    closed: false,
    title: existing.title || incoming.title,
    company: existing.company || incoming.company,
    url: existing.url || incoming.url,
    teaser: existing.teaser ?? incoming.teaser,
    description:
      (incoming.description?.length ?? 0) > (existing.description?.length ?? 0)
        ? incoming.description
        : existing.description,
    salary: existing.salary ?? incoming.salary,
    postedAt: existing.postedAt ?? incoming.postedAt,
    category: existing.category ?? incoming.category,
    employmentType:
      existing.employmentType !== 'unknown' ? existing.employmentType : incoming.employmentType,
    location: existing.location.city ? existing.location : incoming.location,
    // Prefer the freshest value (keeps Seek's isLinkOut current if it ever
    // changes); falls back to whatever's already stored, which is what
    // preserves a LinkedIn job's applyMethod once the apply skill has set
    // it via set-apply-method, since the scraper itself never determines
    // LinkedIn's value and so never has an incoming one to overwrite with.
    applyMethod: incoming.applyMethod ?? existing.applyMethod,
    tags: unique([...existing.tags, ...incoming.tags]),
    seenOn: unique([...existing.seenOn, ...incoming.seenOn]),
    matchedQueries: unique([...existing.matchedQueries, ...incoming.matchedQueries]),
    raw: { ...existing.raw, ...incoming.raw },
  };
  return merged;
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
