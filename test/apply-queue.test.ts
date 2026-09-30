import { describe, it, expect } from 'vitest';
import { buildApplyQueue, platformOf } from '../src/core/apply-queue.js';
import { emptyIndex } from '../src/core/documents-index.js';
import { toJob } from '../src/core/normalize.js';
import { advanceStatus } from '../src/core/pipeline-status.js';
import type { Job, RawJob } from '../src/core/types.js';

function ready(title: string, url: string, over: Partial<Job> = {}): Job {
  const raw: RawJob = { sourceId: url, url, title, company: 'Synechron', locationRaw: 'Melbourne VIC', postedAtRaw: '2026-09-18T00:00:00Z', description: '<p>x</p>' };
  let j = toJob(raw, 'linkedin', 'q', new Date('2026-09-19T00:00:00Z'));
  for (const to of ['fit_good', 'tracked'] as const) {
    const r = advanceStatus(j, to, { actor: 'test' });
    if (!r.ok) throw new Error(r.reason);
    j = r.job;
  }
  return { ...j, careerProfile: 'p', coverLetter: 'l', ...over };
}

function indexFor(jobs: Job[]) {
  const index = emptyIndex('C:\\Users\\madhi\\OneDrive\\Documents\\Resumes Gen');
  for (const j of jobs) {
    index.jobs[j.id] = { company: j.company, title: j.title, folder: 'Synechron', resume: `${j.sourceId.length}_Resume.pdf`, coverLetter: `${j.sourceId.length}_Cover_Letter.pdf`, resumeVersion: 'software-engineer', hash: 'h', generatedAt: '' };
  }
  return index;
}

describe('platformOf', () => {
  it('recognises LinkedIn and SEEK only', () => {
    expect(platformOf('https://www.linkedin.com/jobs/view/123')).toBe('linkedin');
    expect(platformOf('https://au.seek.com/job/123')).toBe('seek');
    expect(platformOf('https://boards.greenhouse.io/x/jobs/1')).toBeUndefined();
  });
});

describe('buildApplyQueue', () => {
  const li = ready('Software Engineer', 'https://www.linkedin.com/jobs/view/1');
  const sk = ready('Java Developer', 'https://au.seek.com/job/22');
  const ext = ready('Backend Engineer', 'https://boards.greenhouse.io/x/jobs/333');
  const blocked = ready('Frontend Engineer', 'https://www.linkedin.com/jobs/view/4444', { applyNote: 'Q: Do you hold a security clearance?' });
  const noDocs = ready('Platform Engineer', 'https://au.seek.com/job/55555');
  const jobs = [li, sk, ext, blocked, noDocs];
  const index = indexFor([li, sk, ext, blocked]);
  const opts = { fileExists: () => true, now: new Date('2026-09-19T00:00:00Z') };

  it('lists ready LinkedIn and SEEK jobs with exact document paths, and skips external, blocked and document-less ones', () => {
    const q = buildApplyQueue(jobs, index, opts);
    expect(q.counts).toEqual({ linkedin: 1, seek: 1 });
    expect(q.missingDocuments).toBe(1);
    const item = q.jobs.find((j) => j.id === li.id)!;
    expect(item.resumeWinPath).toBe(`C:\\Users\\madhi\\OneDrive\\Documents\\Resumes Gen\\Synechron\\${item.resumeFile}`);
    expect(item.platform).toBe('linkedin');
  });

  it('--retry brings back jobs that carry an apply note', () => {
    const q = buildApplyQueue(jobs, index, { ...opts, retry: true });
    expect(q.counts.linkedin).toBe(2);
    expect(q.jobs.find((j) => j.id === blocked.id)?.previousNote).toMatch(/security clearance/);
  });

  it('drops a job whose PDFs are not on disk or were built for another resume version', () => {
    expect(buildApplyQueue(jobs, index, { ...opts, fileExists: () => false }).jobs).toHaveLength(0);
    const stale = indexFor([li]);
    stale.jobs[li.id].resumeVersion = 'test-analyst';
    expect(buildApplyQueue([li], stale, opts).jobs).toHaveLength(0);
  });

  it('carries applyMethod into the queue when known, and omits it when not', () => {
    const tagged = { ...sk, applyMethod: 'quick_apply' as const };
    const q = buildApplyQueue([tagged, li], index, opts);
    expect(q.jobs.find((j) => j.id === sk.id)?.applyMethod).toBe('quick_apply');
    expect(q.jobs.find((j) => j.id === li.id)).not.toHaveProperty('applyMethod');
  });

  it('never includes an applied job', () => {
    const applied = { ...li, pipelineStatus: 'applied' as const };
    expect(buildApplyQueue([applied], index, opts).jobs).toHaveLength(0);
  });
});
