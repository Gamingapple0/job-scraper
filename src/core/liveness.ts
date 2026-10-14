import { BlockedError, HttpError } from './http.js';
import type { HttpLike, Job, LoggerLike } from './types.js';

export type Liveness = 'open' | 'expired' | 'unknown';

/**
 * Reads a listing page and says whether it still takes applications. Pure,
 * so it can be tested against saved HTML. `unknown` (a login wall, a layout
 * change, an unsupported source) never closes a job: only positive evidence
 * does.
 *
 * Seek: the page state carries `"isExpired":true|false` and an expired ad
 * shows "This job is no longer advertised". Checked against live pages on
 * 2026-10-04: an expired Seek ad still returns HTTP 200.
 *
 * LinkedIn guest page: an open listing always renders an apply button
 * tracked as `public_jobs_apply-link-(onsite|simple|offsite)`; a closed one
 * renders the same top card with an empty button container and no text
 * saying so. So "top card present, no apply button" is the closed signal,
 * and a page without a top card (auth wall, error page) stays unknown.
 */
export function detectLiveness(source: string, html: string): Liveness {
  if (source === 'seek') {
    if (/"isExpired"\s*:\s*true/.test(html) || /This job is no longer advertised/i.test(html)) return 'expired';
    if (/"isExpired"\s*:\s*false/.test(html)) return 'open';
    return 'unknown';
  }
  if (source === 'linkedin') {
    if (/public_jobs_apply-link-(onsite|simple|offsite)/.test(html)) return 'open';
    if (/No longer accepting applications/i.test(html)) return 'expired';
    if (html.includes('top-card-layout__cta-container')) return 'expired';
    return 'unknown';
  }
  return 'unknown';
}

const LINKEDIN_DETAIL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';

/** The page to read for a job, or undefined for a source with no check. */
export function livenessUrl(job: Pick<Job, 'source' | 'sourceId' | 'url'>): string | undefined {
  if (job.source === 'seek') return job.url;
  if (job.source === 'linkedin') return LINKEDIN_DETAIL + job.sourceId;
  return undefined;
}

export interface LivenessReport {
  checked: number;
  expired: number;
  open: number;
  unknown: number;
  /** Candidates not checked this call (budget ran out, host blocked, or fetch failed). */
  unchecked: number;
  blockedHosts: string[];
}

export interface LivenessDeps {
  http: HttpLike;
  logger: LoggerLike;
  /** Persist one result. `expiredAt` is set only for an expired job. */
  record(id: string, patch: { liveCheckedAt: string; expiredAt?: string }): void;
}

export interface LivenessOptions {
  /** Epoch ms after which no new request starts. */
  deadline: number;
  /** A job checked more recently than this is skipped. */
  recheckAfterMs: number;
  now?: Date;
}

/**
 * Checks each job's live page, one sequential queue per source so the
 * shared rate limiter paces each host (Seek and LinkedIn run side by side).
 * Fails open: a blocked host, a timeout or an unreadable page leaves the job
 * unchecked and untouched; it is retried on the next call.
 */
export async function checkLiveness(jobs: Job[], deps: LivenessDeps, opts: LivenessOptions): Promise<LivenessReport> {
  const now = opts.now ?? new Date();
  const report: LivenessReport = { checked: 0, expired: 0, open: 0, unknown: 0, unchecked: 0, blockedHosts: [] };
  const due = jobs.filter((j) => {
    if (!livenessUrl(j)) return false;
    if (j.expiredAt) return false;
    const last = j.liveCheckedAt ? Date.parse(j.liveCheckedAt) : NaN;
    return Number.isNaN(last) || now.getTime() - last >= opts.recheckAfterMs;
  });

  const bySource = new Map<string, Job[]>();
  for (const j of due) bySource.set(j.source, [...(bySource.get(j.source) ?? []), j]);

  await Promise.all(
    [...bySource.entries()].map(async ([source, queue]) => {
      for (const job of queue) {
        if (Date.now() >= opts.deadline) break;
        const stamp = new Date().toISOString();
        let verdict: Liveness;
        try {
          const html = await deps.http.getText(livenessUrl(job)!, {
            headers: { Accept: 'text/html,application/xhtml+xml' },
            noCache: true,
          });
          verdict = detectLiveness(source, html);
        } catch (err) {
          if (err instanceof BlockedError) {
            report.blockedHosts.push(source);
            deps.logger.warn(`liveness: ${source} is blocking requests, leaving the rest of its queue for the next call`);
            break;
          }
          // A removed ad is gone for good: 404 or 410 means expired.
          if (err instanceof HttpError && (err.status === 404 || err.status === 410)) verdict = 'expired';
          else {
            deps.logger.warn(`liveness: could not check ${job.url}: ${String(err)}`);
            continue;
          }
        }
        report.checked++;
        report[verdict]++;
        deps.record(job.id, verdict === 'expired' ? { liveCheckedAt: stamp, expiredAt: stamp } : { liveCheckedAt: stamp });
      }
    }),
  );

  report.unchecked = due.length - report.checked;
  return report;
}
