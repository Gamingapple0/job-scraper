import type { ApplyMethod, Job } from './types.js';
import type { DocumentsIndex } from './documents-index.js';
import { pickResumeVersion } from './resume-version.js';
import { selectForStage } from './stage-export.js';

/**
 * The work list for the apply skills (LinkedIn Easy Apply, SEEK Quick
 * Apply): exactly the jobs that are ready to submit, already split by
 * platform, with the tailored text and the exact PDF locations attached.
 * Built by plain code so the skill starts from a short JSON file instead of
 * reading the Google Sheet through a browser, which was the most expensive
 * and least reliable part of every run.
 *
 * A job is in the queue when it is tracked and open, has a current career
 * profile and cover letter (same rule as the documents stage), has PDFs on
 * disk built for its current resume version, sits on LinkedIn or SEEK, and
 * has no applyNote. An applyNote means an earlier attempt already hit
 * something (an unanswered screening question, external-only apply) and
 * retrying blind just repeats the failure; `retry` includes those.
 */

export type ApplyPlatform = 'linkedin' | 'seek';

export interface ApplyJob {
  id: string;
  platform: ApplyPlatform;
  url: string;
  title: string;
  company: string;
  location: string;
  careerProfile: string;
  coverLetter: string;
  fitReason?: string;
  /** Company folder under documentsRoot, and the two PDFs inside it. */
  folder: string;
  resumeFile: string;
  coverLetterFile: string;
  /** The same two files as full Windows paths, ready for the browser's file upload. */
  resumeWinPath: string;
  coverLetterWinPath: string;
  /**
   * How the job is applied to, once known: 'quick_apply' (SEEK, set at scrape
   * time) or 'easy_apply' (LinkedIn, set by the apply skill the first time it
   * opens the listing). Absent means not checked yet. 'external' jobs never
   * reach the queue.
   */
  applyMethod?: ApplyMethod;
  /** Set only with --retry: why the earlier attempt stopped. */
  previousNote?: string;
}

export interface ApplyQueue {
  generatedAt: string;
  documentsRoot: string;
  counts: Record<ApplyPlatform, number>;
  /** Jobs that would qualify but have no PDFs yet: run generate-documents first. */
  missingDocuments: number;
  jobs: ApplyJob[];
}

export function platformOf(url: string): ApplyPlatform | undefined {
  if (/linkedin\.com/i.test(url)) return 'linkedin';
  if (/seek\.com/i.test(url)) return 'seek';
  return undefined;
}

const winJoin = (root: string, ...parts: string[]) => [root.replace(/[\\/]+$/, ''), ...parts].join('\\');

export function buildApplyQueue(
  jobs: Job[],
  index: DocumentsIndex,
  opts: { retry?: boolean; fileExists: (folder: string, file: string) => boolean; now?: Date },
): ApplyQueue {
  const ready = selectForStage(jobs, 'documents');
  const queue: ApplyQueue = {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    documentsRoot: index.rootWindows,
    counts: { linkedin: 0, seek: 0 },
    missingDocuments: 0,
    jobs: [],
  };

  for (const job of ready) {
    const platform = platformOf(job.url);
    if (!platform) continue;
    if (job.applyNote && !opts.retry) continue;

    const entry = index.jobs[job.id];
    const usable =
      entry &&
      entry.resumeVersion === pickResumeVersion(job) &&
      opts.fileExists(entry.folder, entry.resume) &&
      opts.fileExists(entry.folder, entry.coverLetter);
    if (!usable) {
      queue.missingDocuments++;
      continue;
    }

    const item: ApplyJob = {
      id: job.id,
      platform,
      url: job.url,
      title: job.title,
      company: job.company,
      location: job.location.raw,
      careerProfile: job.careerProfile ?? '',
      coverLetter: job.coverLetter ?? '',
      folder: entry.folder,
      resumeFile: entry.resume,
      coverLetterFile: entry.coverLetter,
      resumeWinPath: winJoin(index.rootWindows, entry.folder, entry.resume),
      coverLetterWinPath: winJoin(index.rootWindows, entry.folder, entry.coverLetter),
    };
    if (job.fitReason) item.fitReason = job.fitReason;
    if (job.applyMethod) item.applyMethod = job.applyMethod;
    if (job.applyNote) item.previousNote = job.applyNote;
    queue.jobs.push(item);
    queue.counts[platform]++;
  }

  queue.jobs.sort((a, b) => {
    const ja = jobs.find((j) => j.id === a.id);
    const jb = jobs.find((j) => j.id === b.id);
    return (jb?.postedAt ?? jb?.scrapedAt ?? '').localeCompare(ja?.postedAt ?? ja?.scrapedAt ?? '');
  });
  return queue;
}
