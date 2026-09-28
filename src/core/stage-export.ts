import type { ApplyMethod, Job } from './types.js';
import type { Config } from './config.js';
import { daysSince } from './normalize.js';
import { formatLocation, formatSalary } from './export.js';
import {
  LEGACY_RESUME_VERSION,
  RESUME_BASE_FILE,
  RESUME_DOC_KEY,
  pickResumeVersion,
  type ResumeVersion,
} from './resume-version.js';

export { pickResumeVersion, type ResumeVersion } from './resume-version.js';

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
  /** Only present for the international tracker's Country column. */
  country?: string;
  postedAt?: string;
  salary?: string;
  tags: string[];
  description?: string;
  /** Only present in the tracker-stage export: why the fit-filter agent said yes. */
  fitReason?: string;
  /** How the job is applied to, once known (see ApplyMethod). Shown in the tracker's Apply Method column. */
  applyMethod?: ApplyMethod;
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
  if (job.location.country) clean.country = job.location.country;
  if (job.postedAt) clean.postedAt = job.postedAt;
  const salary = formatSalary(job);
  if (salary) clean.salary = salary;
  if (job.description) clean.description = job.description;
  if (job.fitReason) clean.fitReason = job.fitReason;
  if (job.applyMethod) clean.applyMethod = job.applyMethod;
  return clean;
}

export type Stage = 'fit-filter' | 'tracker' | 'career-profile' | 'cover-letter' | 'materials' | 'documents';

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
  /** Which base resume markdown the tailoring step must read for this job (see RESUME_BASE_FILE). */
  resumeFile: string;
  previousNote?: string;
}

export function toProfileJob(job: Job): ProfileJob {
  const version = pickResumeVersion(job);
  const p: ProfileJob = {
    id: job.id,
    url: job.url,
    title: job.title,
    company: job.company,
    resumeVersion: version,
    resumeFile: RESUME_BASE_FILE[version],
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
  /** Which base resume markdown the drafting step must read for this job (see RESUME_BASE_FILE). */
  resumeFile: string;
  previousNote?: string;
}

export function toCoverLetterJob(job: Job): CoverLetterJob {
  const version = pickResumeVersion(job);
  const c: CoverLetterJob = {
    id: job.id,
    url: job.url,
    title: job.title,
    company: job.company,
    resumeVersion: version,
    resumeFile: RESUME_BASE_FILE[version],
  };
  if (job.description) c.description = job.description;
  if (job.coverLetterNote) c.previousNote = job.coverLetterNote;
  return c;
}

export type MaterialNeed = 'career_profile' | 'cover_letter';

/**
 * What the combined career-profile + cover-letter step gets to see: one
 * record per job, the JD once, and which of the two pieces it still needs.
 * A job that already has a current career profile but no cover letter comes
 * through with `careerProfile` filled in (so the letter can complement it
 * instead of repeating it); a job needing both carries no profile yet, the
 * step writes it first and then the letter in the same pass.
 */
export interface MaterialsJob {
  id: string;
  url: string;
  title: string;
  company: string;
  description?: string;
  resumeVersion: ResumeVersion;
  resumeFile: string;
  needs: MaterialNeed[];
  careerProfile?: string;
  /**
   * Present when an existing profile/letter is being replaced because it was
   * written from a different resume than this job needs. The old text is not
   * sent (it must not be edited or reused), only the reason.
   */
  redo?: string;
  previousNotes?: string[];
}

export function toMaterialsJob(job: Job): MaterialsJob {
  const version = pickResumeVersion(job);
  const needs: MaterialNeed[] = [];
  const wantsProfile = needsProfile(job);
  if (wantsProfile) needs.push('career_profile');
  if (needsLetter(job)) needs.push('cover_letter');
  const m: MaterialsJob = {
    id: job.id,
    url: job.url,
    title: job.title,
    company: job.company,
    resumeVersion: version,
    resumeFile: RESUME_BASE_FILE[version],
    needs,
  };
  if (job.description) m.description = job.description;
  if (!wantsProfile && job.careerProfile) m.careerProfile = job.careerProfile;
  const drifted = [profileDrifted(job) && 'career profile', coverLetterDrifted(job) && 'cover letter'].filter(Boolean);
  if (drifted.length > 0) {
    const was = job.careerProfileVersion ?? job.coverLetterVersion ?? LEGACY_RESUME_VERSION;
    m.redo = `existing ${drifted.join(' and ')} written from the ${was} resume; this job needs ${version}. Write fresh, do not reuse the old text.`;
  }
  const notes = [job.profileNote, job.coverLetterNote].filter((n): n is string => Boolean(n));
  if (notes.length > 0) m.previousNotes = notes;
  return m;
}

/**
 * What the (zero-LLM-cost) document-generation step gets to see — enough
 * to pick a base resume doc and name the output files. career_profile and
 * cover_letter are already-finished text written by the earlier stages;
 * this step only swaps them into documents, never rewrites them.
 */
export interface DocumentJob {
  id: string;
  title: string;
  company: string;
  careerProfile: string;
  coverLetter: string;
  resumeVersion: ResumeVersion;
  /** See relocationNote() — null when the job is Melbourne, VIC (home base, nothing to add). */
  relocationNote: string | null;
  /**
   * True for any job outside Australia. Drives the international-specific
   * document tweaks in generate_documents.py (the +61 phone format and the
   * "PTE: 88" headline addition — a local 04... number and no English-test
   * score don't read right on an overseas application) and which of the
   * two output subfolders (AU / International) its PDFs land in.
   */
  isInternational: boolean;
}

export function toDocumentJob(job: Job): DocumentJob {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    careerProfile: job.careerProfile ?? '',
    coverLetter: job.coverLetter ?? '',
    resumeVersion: pickResumeVersion(job),
    relocationNote: relocationNote(job),
    isInternational: job.location.country !== 'AU',
  };
}

/** Country codes the searches in config.json actually target — see relocationNote(). */
const COUNTRY_NAMES: Record<string, string> = {
  NZ: 'New Zealand',
  IE: 'Ireland',
  GB: 'United Kingdom',
  DE: 'Germany',
  NL: 'Netherlands',
  CA: 'Canada',
  SG: 'Singapore',
  AE: 'United Arab Emirates',
};

/**
 * "Open to relocation to <X>" for the resume header, next to Anshu's name —
 * null for a Melbourne, VIC job (home base, nothing to flag). For any other
 * AU state, X is that state's own abbreviation (job.location.state is
 * already stored as one, e.g. "NSW"); outside Australia, X is the full
 * country name. An AU job with no state on it (e.g. the "AU-wide remote"
 * search, which carries no specific state) is left alone rather than
 * guessed at.
 */
export function relocationNote(job: Job): string | null {
  const loc = job.location;
  if (loc.country !== 'AU') return `Open to relocation to ${COUNTRY_NAMES[loc.country] ?? loc.country}`;
  if (loc.state && loc.state !== 'VIC') return `Open to relocation to ${loc.state}`;
  return null;
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
 * A career profile / cover letter is "drifted" when the resume version it
 * was written from no longer matches what the job classifies as now. That
 * is exactly how a software-engineer profile ended up in a test-analyst
 * application: nothing ever compared the two. Drifted text is treated as
 * missing, so the stage that owns it re-queues it, and the documents stage
 * refuses to build with it.
 */
export function profileDrifted(j: Job): boolean {
  return Boolean(j.careerProfile) && (j.careerProfileVersion ?? LEGACY_RESUME_VERSION) !== pickResumeVersion(j);
}

export function coverLetterDrifted(j: Job): boolean {
  return Boolean(j.coverLetter) && (j.coverLetterVersion ?? LEGACY_RESUME_VERSION) !== pickResumeVersion(j);
}

/**
 * A job the profile step already flagged as disqualifying (no sponsorship,
 * clearance, citizenship) is not re-sent every night: the JD has not
 * changed, so re-judging it only spends tokens to reach the same answer.
 * Typing a career profile into the Sheet still clears the flag.
 */
function isDisqualified(j: Job): boolean {
  return !j.careerProfile && Boolean(j.profileNote?.startsWith('DISQUALIFYING'));
}

function needsProfile(j: Job): boolean {
  if (isDisqualified(j)) return false;
  return !j.careerProfile || profileDrifted(j);
}

function needsLetter(j: Job): boolean {
  if (isDisqualified(j)) return false;
  return !j.coverLetter || coverLetterDrifted(j);
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

  if (stage === 'documents') {
    // Resume/cover-letter PDFs are generated for every currently-unapplied
    // tracked job that has both texts ready — regenerated every run rather
    // than ratcheted, since Anshu may want a fresh PDF batch at any time
    // (e.g. after editing the base resume doc) without a status field
    // gating it. Zero LLM cost: career_profile/cover_letter are already
    // finished text, this stage only lays them into documents.
    // Drifted text counts as missing: never build a PDF from a profile or
    // letter written for a different resume version than the job needs.
    return jobs.filter(
      (j) => isStillOpen(j) && j.pipelineStatus === 'tracked' && !needsProfile(j) && !needsLetter(j),
    );
  }

  if (stage === 'cover-letter') {
    // only jobs the career-profile agent has already produced a profile
    // for, in this run or an earlier one — the cover-letter agent never
    // runs ahead of the career-profile agent. No coverLetter yet, same
    // "stops selecting once set" rule as career-profile.
    return jobs.filter((j) => isStillOpen(j) && j.pipelineStatus === 'tracked' && !needsProfile(j) && needsLetter(j));
  }

  if (stage === 'materials') {
    // Union of career-profile and cover-letter: everything either stage
    // would pick up, as one list, so a single pass reads each JD once.
    return jobs.filter((j) => isStillOpen(j) && j.pipelineStatus === 'tracked' && (needsProfile(j) || needsLetter(j)));
  }

  // career-profile stage: tracked jobs with no careerProfile yet. Once
  // careerProfile is set — by the LLM step or by Anshu typing straight into
  // the Sheet and sync-sheet pulling it back — this stops selecting the
  // job, same as 'applied' jobs never landing here at all. Jobs still
  // carrying an unresolved profileNote (needs_clarification / disqualifying)
  // ARE re-selected every run: cheap to retry, and it resolves itself once
  // Claude outputs/tailoring-clarifications.md is updated, no separate
  // "pending" pipeline status required.
  return jobs.filter((j) => isStillOpen(j) && j.pipelineStatus === 'tracked' && needsProfile(j));
}

/* -------------------------------------------- documents: naming helpers */

const FILENAME_PREFIX = 'Anshu_Madhikarmi_';
const RESUME_SUFFIX = '_Resume.docx';
const COVER_LETTER_SUFFIX = '_Cover_Letter.docx';

/**
 * Hard cap on the whole file name. Budgeted against the Cover Letter suffix
 * (the longer of the two variants), so both a resume and its cover letter
 * always stay at or under this — Windows Explorer, an email attachment, and
 * every job-board upload dialog show the name in full instead of an
 * ellipsis.
 */
export const MAX_FILENAME_LENGTH = 75;

/**
 * Replaces every run of characters that isn't a letter or digit — spaces,
 * commas, slashes, parentheses, ampersands, dashes, colons, anything
 * Windows rejects or just clutters a filename — with a single underscore,
 * then trims stray underscores off each end. A whole run collapses to one
 * underscore rather than several in a row, which is what keeps something
 * like "Java/React" or "R&D - Full-Stack" from turning into an eyesore of
 * doubled-up underscores.
 */
export function sanitizeFilenamePart(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** A company name counts as "too weird" for a filename once it's long or has a lot of words. */
export function isWeirdCompanyName(company: string): boolean {
  const words = company.trim().split(/\s+/).filter(Boolean);
  return company.length > 30 || words.length > 4;
}

export function companyAcronym(company: string): string {
  return company
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export function companyToken(company: string): string {
  return isWeirdCompanyName(company) ? companyAcronym(company) : sanitizeFilenamePart(company);
}

/**
 * Everything from the start of the title up to its first clause break — a
 * " - " / " – " / " — ", a comma, a slash, a colon, a semicolon, a pipe, or
 * an opening bracket. Job titles routinely tack a whole classification tree
 * onto the actual role, e.g. "Assoc Delivery Cons - App/Dev, Associate to
 * Consultant (A2C) ProServe Shared Delivery (SDT)" — everything after that
 * first break is the tree, not the job, so it's what gets dropped first
 * when the full title won't fit.
 */
function titleClause(title: string): string {
  const idx = title.search(/\s[-–—]\s|[,/(:;|]/);
  return (idx === -1 ? title : title.slice(0, idx)).trim();
}

/** Cuts a sanitized token down to `max` characters without leaving a chopped-off partial word or a trailing underscore. */
function truncateToken(token: string, max: number): string {
  if (token.length <= max) return token;
  const cut = token.slice(0, max).replace(/_+$/, '');
  const lastUnderscore = cut.lastIndexOf('_');
  const wholeWords = lastUnderscore > 0 ? cut.slice(0, lastUnderscore) : cut;
  return (wholeWords || cut).replace(/_+$/, '') || cut;
}

/**
 * The title text that goes into a resume/cover-letter file name: the full
 * sanitized title when it's short and clean enough to fit the budget,
 * otherwise just its first clause (titleClause), otherwise that clause
 * hard-truncated to fit. There's no need to spell out the full job title
 * when it's full of special characters or just long — the short form reads
 * better and still identifies the role.
 */
function titleToken(title: string, company: string): string {
  const budget =
    MAX_FILENAME_LENGTH - FILENAME_PREFIX.length - companyToken(company).length - 1 /* joining underscore */ - COVER_LETTER_SUFFIX.length;
  const full = sanitizeFilenamePart(title);
  if (full.length <= budget) return full || 'Role';
  const clause = sanitizeFilenamePart(titleClause(title));
  if (clause && clause.length <= budget) return clause;
  return truncateToken(clause || full, Math.max(budget, 1)) || 'Role';
}

/**
 * [Name]_[Company]_[Role]_[Resume/Cover_Letter], capped at MAX_FILENAME_LENGTH
 * — sorts by company first, which is what makes a folder of 29 of these easy
 * to scan. Company and title both go through sanitizeFilenamePart, so every
 * special character (including "&", "-", ",", "/") becomes a single "_"
 * rather than being dropped or left in; a title that's long or cluttered
 * with classification tags is shortened to its first clause (or, failing
 * that, hard-truncated) instead of overflowing the cap.
 */
export function buildResumeFileName(title: string, company: string): string {
  return `${FILENAME_PREFIX}${companyToken(company)}_${titleToken(title, company)}${RESUME_SUFFIX}`;
}

export function buildCoverLetterFileName(title: string, company: string): string {
  return `${FILENAME_PREFIX}${companyToken(company)}_${titleToken(title, company)}${COVER_LETTER_SUFFIX}`;
}

/** The Google Doc id for a resume version. The version itself comes from classifyResumeVersion, never from a second title check here. */
export function resumeDocFor(version: ResumeVersion, cfg: Config): string {
  return cfg.pipeline.documentsResumeDocs[RESUME_DOC_KEY[version]];
}
