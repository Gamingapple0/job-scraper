/**
 * Shared types. Everything downstream of an adapter speaks these types only,
 * so adding a new job board never touches the pipeline, store or CLI.
 */

export type SourceName = string;

/** What an adapter emits. Source-shaped strings, minimal interpretation. */
export interface RawJob {
  /** Stable id from the source itself (Seek job id, LinkedIn jobPostingId, ...). */
  sourceId: string;
  /** Canonical public URL of the posting. */
  url: string;
  title: string;
  company: string;
  /** Whatever the source calls the location, unparsed. */
  locationRaw: string;
  /** Unparsed salary string, if the source shows one. */
  salaryRaw?: string;
  /** ISO date, or a relative string like "3 days ago". */
  postedAtRaw?: string;
  /** "Full time", "Contract/Temp", ... */
  employmentTypeRaw?: string;
  /** Short summary shown on the results card. */
  teaser?: string;
  /** Full description, usually only present after fetchDetail(). */
  description?: string;
  /** Source-provided category, e.g. Seek classification. */
  category?: string;
  /** Source says this is remote / hybrid. */
  remoteHint?: boolean;
  /** Untouched payload, kept so normalization can be redone without re-scraping. */
  raw: unknown;
}

export type EmploymentType =
  | 'full-time'
  | 'part-time'
  | 'contract'
  | 'casual'
  | 'internship'
  | 'unknown';

export interface Salary {
  min?: number;
  max?: number;
  currency: string;
  period: 'year' | 'month' | 'day' | 'hour' | 'unknown';
  raw: string;
}

export interface JobLocation {
  raw: string;
  city?: string;
  state?: string;
  country: string;
  remote: boolean;
}

/**
 * Where a job sits in the multi-stage pipeline (scraper -> fit-filter agent
 * -> tracker/cover-letter agent -> you applying). This is a one-way ratchet:
 * see pipeline-status.ts for the allowed transitions. It exists so that
 * every downstream stage can be handed a small, pre-filtered file containing
 * only the jobs that are its job to look at — no LLM should ever have to
 * read pipelineStatus itself to decide "is this mine to process", because
 * that decision must cost zero tokens and scale to years of history.
 *
 *   scraped -> fit_good -> tracked -> applied
 *           -> fit_bad  (terminal)
 *
 * `applied` can also be reached directly from fit_good (you can apply
 * without a tracker record existing yet). fit_bad is a dead end: a job
 * judged a bad fit is never re-judged by a later scrape of the same posting.
 */
export type PipelineStatus = 'scraped' | 'fit_good' | 'fit_bad' | 'tracked' | 'applied';

export const PIPELINE_STATUSES: readonly PipelineStatus[] = [
  'scraped',
  'fit_good',
  'fit_bad',
  'tracked',
  'applied',
];

/** One entry per status change, kept for debugging "why is this job here". */
export interface PipelineStatusEvent {
  at: string; // ISO 8601
  from: PipelineStatus;
  to: PipelineStatus;
  /** Who/what made the change: 'fit-filter-agent', 'sheet-sync', 'manual', ... */
  actor: string;
  reason?: string;
}

/** The canonical record. One shape for every source. */
export interface Job {
  /** sha1(source + ':' + sourceId) */
  id: string;
  /** sha1(normalised title + company + city). Used for cross-source dedupe. */
  fingerprint: string;
  source: SourceName;
  sourceId: string;
  url: string;

  title: string;
  company: string;
  location: JobLocation;

  /** ISO 8601, when the source says it was listed. */
  postedAt?: string;
  /** ISO 8601, first time we saw it. */
  scrapedAt: string;
  /** ISO 8601, most recent run that saw it. */
  lastSeenAt: string;
  /** Runs in a row that did not see it. 3+ means probably closed. */
  missedRuns: number;
  closed: boolean;

  salary?: Salary;
  employmentType: EmploymentType;
  category?: string;
  teaser?: string;
  description?: string;
  tags: string[];

  /** Every source this posting has been seen on. */
  seenOn: SourceName[];
  /** Search queries that surfaced it. */
  matchedQueries: string[];

  /**
   * Where this job sits in the downstream pipeline. Re-scraping an existing
   * job NEVER changes this — see mergeJob() in dedupe.ts, which always keeps
   * the existing value. Only the pipeline-status commands (apply-fit-verdicts,
   * mark-applied, sync-applied) are allowed to advance it.
   */
  pipelineStatus: PipelineStatus;
  /** Audit trail of every status change. Preserved across re-scrapes. */
  statusHistory: PipelineStatusEvent[];
  /** Why the fit-filter agent judged this job good or bad, if it has run. */
  fitReason?: string;

  /**
   * Set once the career-profile stage has produced tailored copy for this
   * job. Orthogonal to pipelineStatus on purpose: it's a side-quest, not a
   * ratchet step, so it never blocks or is blocked by the main
   * scraped -> fit_good -> tracked -> applied flow. Presence of this field
   * (from the LLM stage, OR from Anshu typing straight into the Sheet and
   * sync-sheet pulling it back) is what tells export-profile-inbox to leave
   * a job alone — there's no separate "done" status to track.
   */
  careerProfile?: string;
  technicalSkills?: string[];
  /**
   * Set when the career-profile stage couldn't produce careerProfile for
   * this job yet: an unresolved clarifying question, or a disqualifying
   * requirement it spotted. Surfaced in the Sheet's Notes column so Anshu
   * sees it without the run stalling. Cleared automatically the moment
   * careerProfile gets set (by the LLM or manually). export-profile-inbox
   * retries jobs carrying this note on every run — cheap, and it resolves
   * itself once Claude outputs/tailoring-clarifications.md answers the
   * question, with no separate "pending" pipeline status needed.
   */
  profileNote?: string;

  /**
   * Set once the cover-letter stage has produced a draft for this job, or
   * Anshu has typed one straight into the Sheet's Cover Letter column and
   * sync-sheet pulled it back — same non-ratchet, side-quest pattern as
   * careerProfile. Only ever selected for by selectForStage('cover-letter'),
   * which additionally requires careerProfile to already be set: the
   * cover-letter agent always runs after the career-profile agent within
   * the same pipeline run, never before.
   */
  coverLetter?: string;
  /** Same idea as profileNote, but for an unresolved cover-letter question. */
  coverLetterNote?: string;
  /**
   * Anshu's own manual application-outcome tracking column in the Sheet
   * (Take home / Initial Screen / Final Round / Offer / NA / Invalid, or
   * anything else he types there) — pulled back by sync-sheet, never
   * written by any agent. Deliberately separate from pipelineStatus: it
   * exists purely so selectForStage can refuse to send a job to ANY agent
   * once Anshu has recorded an outcome for it, regardless of what
   * pipelineStatus that job happens to still be sitting at.
   */
  interviewStage?: string;

  raw: Record<SourceName, unknown>;
}

export interface SearchQuery {
  /** Free-text keywords. */
  query: string;
  /** Source-specific location string, e.g. "All Melbourne VIC". */
  location: string;
  /** Which adapters to run this query through. */
  sources: SourceName[];
  /** Hard cap on result pages per source. */
  maxPages?: number;
  /** Only keep jobs listed within this many days. */
  maxAgeDays?: number;
  /** Optional label used in logs and stats. */
  label?: string;
}

export interface RunOptions {
  maxPages: number;
  maxAgeDays?: number;
  /** Fetch the full description for each new job (one extra request per job). */
  detail: boolean;
  dryRun: boolean;
}

/** Anything an adapter needs from the runtime. Keeps adapters free of globals. */
export interface AdapterContext {
  http: HttpLike;
  logger: LoggerLike;
  /** Per-source settings from config.json -> sources[name]. */
  settings: Record<string, unknown>;
}

export interface HttpLike {
  getJson<T = unknown>(url: string, init?: RequestInitLike): Promise<T>;
  getText(url: string, init?: RequestInitLike): Promise<string>;
}

export interface RequestInitLike {
  headers?: Record<string, string>;
  /** Skip the on-disk response cache for this call. */
  noCache?: boolean;
  /** Override the default cache lifetime, in ms. */
  cacheTtlMs?: number;
}

export interface LoggerLike {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/**
 * The only contract a job board has to satisfy.
 *
 * search() is an async generator so pagination streams: a run that dies on
 * page 12 has already persisted pages 1 to 11.
 */
export interface SourceAdapter {
  readonly name: SourceName;
  search(query: SearchQuery, opts: RunOptions): AsyncGenerator<RawJob, void, void>;
  /** Optional second request that fills in the full description. */
  fetchDetail?(job: RawJob): Promise<Partial<RawJob>>;
  /**
   * Optional. Writes one raw response to data/.cache for inspection.
   * Used by `cli discover` when a source's private API changes shape.
   */
  discover?(query: SearchQuery): Promise<unknown>;
}

export type AdapterFactory = (ctx: AdapterContext) => SourceAdapter;

export interface UpsertResult {
  status: 'new' | 'updated' | 'merged';
  job: Job;
}

export interface RunStats {
  source: SourceName;
  query: string;
  location: string;
  fetched: number;
  created: number;
  updated: number;
  merged: number;
  skippedTooOld: number;
  errors: number;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  note?: string;
}
