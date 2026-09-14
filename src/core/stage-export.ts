import type { Job } from './types.js';
import { daysSince } from './normalize.js';
import { formatLocation, formatSalary } from './export.js';

/**
 * The minimal shape handed to an LLM stage. Deliberately excludes `raw`,
 * `statusHistory`, `matchedQueries`, `seenOn` and every id/hash a human
 * wouldn't write by hand — those exist for the scraper's own bookkeeping,
 * not for a model deciding fit or drafting a cover letter. Every field left
 * in is one an agent will actually read.
 */
export interface CleanJob {
  id: string;
  url: string;
  title: string;
  company: string;
  location: string;
  postedAt?: string;
  salary?: string;
  tags: string[];
  description?: string;
  /** Only present in the tracker-stage export: why the fit-filter agent said yes. */
  fitReason?: string;
}

export function toCleanJob(job: Job): CleanJob {
  const clean: CleanJob = {
    id: job.id,
    url: job.url,
    title: job.title,
    company: job.company,
    location: formatLocation(job),
    tags: job.tags,
  };
  if (job.postedAt) clean.postedAt = job.postedAt;
  const salary = formatSalary(job);
  if (salary) clean.salary = salary;
  if (job.description) clean.description = job.description;
  if (job.fitReason) clean.fitReason = job.fitReason;
  return clean;
}

export type Stage = 'fit-filter' | 'tracker' | 'career-profile' | 'cover-letter';

/**
 * Only 'software-engineer' is wired up today — every search in config.json
 * (java-backend, react-frontend, junior-swe) targets software engineer
 * roles, so a Test Analyst variant has nowhere to be used yet. Add a real
 * rule here (and a second base resume) if a QA/test search is ever added;
 * until then this is deliberately a stub, not a guess.
 */
export type ResumeVersion = 'software-engineer';

export function pickResumeVersion(_job: Job): ResumeVersion {
  return 'software-engineer';
}

/**
 * What the career-profile tailoring step gets to see — the job's own JD
 * text (`description`), which base resume to tailor from, and whatever
 * note is already sitting on the job (so the LLM step knows a clarifying
 * question was asked before and can check the answers file rather than
 * re-asking blind). No fitReason, tags or salary — the tailoring prompt
 * doesn't use them, so they'd only be tokens spent for nothing.
 */
export interface ProfileJob {
  id: string;
  url: string;
  title: string;
  company: string;
  description?: string;
  resumeVersion: ResumeVersion;
  previousNote?: string;
}

export function toProfileJob(job: Job): ProfileJob {
  const p: ProfileJob = {
    id: job.id,
    url: job.url,
    title: job.title,
    company: job.company,
    resumeVersion: pickResumeVersion(job),
  };
  if (job.description) p.description = job.description;
  if (job.profileNote) p.previousNote = job.profileNote;
  return p;
}

/**
 * What the cover-letter drafting step gets to see. Same shape as
 * ProfileJob for the same reason (JD text + which base resume, nothing
 * else) — kept as its own type rather than reused because previousNote
 * here reads coverLetterNote, not profileNote; the two stages track
 * separate open questions.
 */
export interface CoverLetterJob {
  id: string;
  url: string;
  title: string;
  company: string;
  description?: string;
  resumeVersion: ResumeVersion;
  previousNote?: string;
}

export function toCoverLetterJob(job: Job): CoverLetterJob {
  const c: CoverLetterJob = {
    id: job.id,
    url: job.url,
    title: job.title,
    company: job.company,
    resumeVersion: pickResumeVersion(job),
  };
  if (job.description) c.description = job.description;
  if (job.coverLetterNote) c.previousNote = job.coverLetterNote;
  return c;
}

export interface StageSelectOptions {
  /**
   * For the fit-filter stage only: skip jobs older than this even though
   * they're still sitting at pipelineStatus 'scraped'. There's no point
   * spending a token judging fit on a listing that's probably already
   * filled — filter it out before the agent ever sees it, not after.
   */
  maxAgeDays?: number;
  now?: Date;
}

/**
 * True once Anshu has recorded an interview-stage outcome for a job in the
 * Sheet (Take home / Initial Screen / Final Round / Offer / NA / Invalid).
 * Checked first, ahead of every stage-specific rule below: a job he's
 * already marked with an outcome must stop being sent to ANY agent —
 * resume, cover letter, or otherwise — no matter what pipelineStatus it
 * still happens to sit at, so a manual Sheet edit takes effect on the very
 * next run without needing a matching status transition to exist.
 */
function isStillOpen(j: Job): boolean {
  return !j.closed && !j.interviewStage;
}

/**
 * The ONLY logic that decides what a downstream agent is allowed to see.
 * This must stay plain, deterministic code — never an LLM call — because
 * "is this job mine to process" has to cost zero tokens and scale to years
 * of accumulated history in jobs.json without the cost growing with it.
 */
export function selectForStage(jobs: Job[], stage: Stage, opts: StageSelectOptions = {}): Job[] {
  const now = opts.now ?? new Date();

  if (stage === 'fit-filter') {
    return jobs.filter((j) => {
      if (!isStillOpen(j)) return false;
      if (j.pipelineStatus !== 'scraped') return false;
      if (opts.maxAgeDays !== undefined) {
        const age = daysSince(j.postedAt ?? j.scrapedAt, now);
        if (age !== undefined && age > opts.maxAgeDays) return false;
      }
      return true;
    });
  }

  if (stage === 'tracker') {
    // only jobs the fit-filter agent has already approved.
    return jobs.filter((j) => isStillOpen(j) && j.pipelineStatus === 'fit_good');
  }

  if (stage === 'cover-letter') {
    // only jobs the career-profile agent has already produced a profile
    // for, in this run or an earlier one — the cover-letter agent never
    // runs ahead of the career-profile agent. No coverLetter yet, same
    // "stops selecting once set" rule as career-profile.
    return jobs.filter(
      (j) => isStillOpen(j) && j.pipelineStatus === 'tracked' && Boolean(j.careerProfile) && !j.coverLetter,
    );
  }

  // career-profile stage: tracked jobs with no careerProfile yet. Once
  // careerProfile is set — by the LLM step or by Anshu typing straight into
  // the Sheet and sync-sheet pulling it back — this stops selecting the
  // job, same as 'applied' jobs never landing here at all. Jobs still
  // carrying an unresolved profileNote (needs_clarification / disqualifying)
  // ARE re-selected every run: cheap to retry, and it resolves itself once
  // Claude outputs/tailoring-clarifications.md is updated, no separate
  // "pending" pipeline status required.
  return jobs.filter((j) => isStillOpen(j) && j.pipelineStatus === 'tracked' && !j.careerProfile);
}
