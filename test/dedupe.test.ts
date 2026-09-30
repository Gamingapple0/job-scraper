import { describe, it, expect } from 'vitest';
import { normalizeCompany, normalizeTitle, titleSimilarity, makeFingerprint } from '../src/core/dedupe.js';
import { toJob } from '../src/core/normalize.js';
import { JsonStore } from '../src/core/store.js';
import type { RawJob } from '../src/core/types.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function raw(over: Partial<RawJob> = {}): RawJob {
  return {
    sourceId: '1',
    url: 'https://example.com/job/1',
    title: 'Software Engineer',
    company: 'Acme Software Pty Ltd',
    locationRaw: 'Melbourne, CBD & Inner Suburbs',
    raw: {},
    ...over,
  };
}

describe('normalisation for dedupe', () => {
  it('strips company noise', () => {
    expect(normalizeCompany('Acme Software Pty Ltd')).toBe(normalizeCompany('Acme Software'));
    expect(normalizeCompany('Atlassian Australia')).toBe('atlassian');
  });

  it('strips title decoration but keeps seniority', () => {
    expect(normalizeTitle('Software Engineer (Remote)')).toBe('software engineer');
    expect(normalizeTitle('Software Engineer | Melbourne')).toBe('software engineer');
    expect(normalizeTitle('Senior Software Engineer')).not.toBe(normalizeTitle('Software Engineer'));
  });

  it('scores title similarity', () => {
    expect(titleSimilarity('Software Engineer', 'Software Engineer')).toBe(1);
    expect(titleSimilarity('Software Engineer', 'Software Developer')).toBeLessThan(0.8);
    expect(titleSimilarity('Software Engineer', 'Chef')).toBe(0);
  });

  it('treats "Associate" as a cross-platform title-tier label, not a real seniority split', () => {
    // Real case: nCino posted the same role as "Software Engineer" on
    // LinkedIn and "Associate Software Engineer" on Seek.
    expect(normalizeTitle('Associate Software Engineer')).toBe(normalizeTitle('Software Engineer'));
    expect(titleSimilarity('Associate Software Engineer', 'Software Engineer')).toBe(1);
  });

  it('fingerprints on title + company + city', () => {
    const a = makeFingerprint('Software Engineer', 'Acme Software Pty Ltd', 'Melbourne');
    const b = makeFingerprint('Software Engineer (Remote)', 'Acme Software', 'Melbourne');
    expect(a).toBe(b);
  });
});

describe('JsonStore.upsert', () => {
  async function store() {
    const dir = await mkdtemp(join(tmpdir(), 'jobstore-'));
    const s = new JsonStore(dir, true);
    await s.load();
    return s;
  }

  it('inserts once, updates on re-scrape', async () => {
    const s = await store();
    expect(s.upsert(toJob(raw(), 'seek', 'swe')).status).toBe('new');
    expect(s.upsert(toJob(raw(), 'seek', 'swe')).status).toBe('updated');
  });

  it('merges the same posting seen on a second source', async () => {
    const s = await store();
    s.upsert(toJob(raw(), 'seek', 'swe'));
    const fromElsewhere = toJob(
      raw({ sourceId: 'X9', url: 'https://other.example/job/X9', company: 'Acme Software' }),
      'linkedin',
      'swe',
    );
    const res = s.upsert(fromElsewhere);
    expect(res.status).toBe('merged');
    expect(res.job.seenOn.sort()).toEqual(['linkedin', 'seek']);
  });

  it('merges the same posting across sources even when one adds "Associate"', async () => {
    const s = await store();
    s.upsert(toJob(raw({ title: 'Software Engineer' }), 'linkedin', 'swe'));
    const fromSeek = toJob(
      raw({
        sourceId: 'X9',
        url: 'https://other.example/job/X9',
        company: 'Acme Software',
        title: 'Associate Software Engineer',
      }),
      'seek',
      'swe',
    );
    const res = s.upsert(fromSeek);
    expect(res.status).toBe('merged');
  });

  it('keeps genuinely different roles at the same company apart', async () => {
    const s = await store();
    s.upsert(toJob(raw({ title: 'Software Engineer' }), 'seek', 'swe'));
    const senior = s.upsert(toJob(raw({ sourceId: '2', title: 'Senior Software Engineer' }), 'seek', 'swe'));
    expect(senior.status).toBe('new');
  });

  it('prefers the richer description when merging', async () => {
    const s = await store();
    s.upsert(toJob(raw(), 'seek', 'swe'));
    const withDesc = toJob(raw({ description: 'A much longer description of the role.' }), 'seek', 'swe');
    const res = s.upsert(withDesc);
    expect(res.job.description).toContain('longer description');
  });

  it('takes the freshest applyMethod on a re-scrape (Seek can tell every time)', async () => {
    const s = await store();
    s.upsert(toJob(raw({ applyMethod: 'external' }), 'seek', 'swe'));
    const res = s.upsert(toJob(raw({ applyMethod: 'quick_apply' }), 'seek', 'swe'));
    expect(res.job.applyMethod).toBe('quick_apply');
  });

  it('keeps the stored applyMethod when a re-scrape has none to offer (LinkedIn, which the scraper never tags)', async () => {
    const s = await store();
    s.upsert(toJob(raw({ applyMethod: 'easy_apply' }), 'linkedin', 'swe'));
    // A later re-scrape of the same posting carries no applyMethod at all —
    // the LinkedIn adapter never sets one — so the value the apply skill
    // recorded earlier via set-apply-method must survive, not get wiped.
    const res = s.upsert(toJob(raw(), 'linkedin', 'swe'));
    expect(res.job.applyMethod).toBe('easy_apply');
  });

  it('ages out jobs that stop appearing', async () => {
    const s = await store();
    const job = s.upsert(toJob(raw(), 'seek', 'swe')).job;
    s.ageOut(new Set(), 3);
    s.ageOut(new Set(), 3);
    expect(s.get(job.id)?.closed).toBe(false);
    s.ageOut(new Set(), 3);
    expect(s.get(job.id)?.closed).toBe(true);
    s.upsert(toJob(raw(), 'seek', 'swe'));
    expect(s.get(job.id)?.closed).toBe(false);
  });

  it('never resets pipelineStatus on a re-scrape — this is the whole point of the ratchet', async () => {
    const s = await store();
    const inserted = s.upsert(toJob(raw(), 'seek', 'swe')).job;
    expect(inserted.pipelineStatus).toBe('scraped');

    const advanced = s.updateStatus(inserted.id, 'fit_good', { actor: 'fit-filter-agent', reason: 'good match' });
    expect(advanced.ok).toBe(true);
    expect(s.get(inserted.id)?.pipelineStatus).toBe('fit_good');

    // The scraper runs again tomorrow and sees the same posting. This must
    // NOT undo the fit_good verdict, or the fit-filter agent would burn a
    // token re-judging a job it already decided on.
    const rescraped = s.upsert(toJob(raw(), 'seek', 'swe'));
    expect(rescraped.status).toBe('updated');
    expect(rescraped.job.pipelineStatus).toBe('fit_good');
    expect(rescraped.job.fitReason).toBe('good match');
    expect(rescraped.job.statusHistory).toHaveLength(1);
  });

  it('preserves pipelineStatus across a cross-source merge too', async () => {
    const s = await store();
    const inserted = s.upsert(toJob(raw(), 'seek', 'swe')).job;
    s.updateStatus(inserted.id, 'fit_good', { actor: 'x' });

    const fromElsewhere = toJob(
      raw({ sourceId: 'X9', url: 'https://other.example/job/X9', company: 'Acme Software' }),
      'linkedin',
      'swe',
    );
    const res = s.upsert(fromElsewhere);
    expect(res.status).toBe('merged');
    expect(res.job.pipelineStatus).toBe('fit_good');
  });

  it('updateStatus refuses an unknown id without throwing', async () => {
    const s = await store();
    const res = s.updateStatus('does-not-exist', 'fit_good', { actor: 'x' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown id');
  });

  it('updateStatus refuses a disallowed transition and leaves the job untouched', async () => {
    const s = await store();
    const inserted = s.upsert(toJob(raw(), 'seek', 'swe')).job;
    s.updateStatus(inserted.id, 'fit_bad', { actor: 'x' });

    const res = s.updateStatus(inserted.id, 'fit_good', { actor: 'x' });
    expect(res.ok).toBe(false);
    expect(s.get(inserted.id)?.pipelineStatus).toBe('fit_bad');
  });
});
