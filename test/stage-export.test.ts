import { describe, it, expect } from 'vitest';
import { selectForStage, toCleanJob, toCoverLetterJob, toDocumentJob, relocationNote } from '../src/core/stage-export.js';
import { toJob } from '../src/core/normalize.js';
import { advanceStatus } from '../src/core/pipeline-status.js';
import type { Job, RawJob } from '../src/core/types.js';

function makeJob(over: Partial<RawJob> = {}, postedDaysAgo = 1, now = new Date('2026-09-06T00:00:00Z')): Job {
  const raw: RawJob = {
    sourceId: over.sourceId ?? Math.random().toString(36).slice(2),
    url: 'https://example.com/job/1',
    title: 'Software Engineer',
    company: 'Acme',
    locationRaw: 'Melbourne VIC',
    postedAtRaw: new Date(now.getTime() - postedDaysAgo * 86_400_000).toISOString(),
    description: '<p>Build things.</p>',
    ...over,
  };
  return toJob(raw, 'seek', 'swe', now);
}

function withStatus(job: Job, to: Job['pipelineStatus']): Job {
  const res = advanceStatus(job, to, { actor: 'test' });
  if (!res.ok) throw new Error(`setup failed: ${res.reason}`);
  return res.job;
}

const NOW = new Date('2026-09-06T00:00:00Z');

describe('selectForStage: fit-filter', () => {
  it('includes fresh, unjudged jobs', () => {
    const j = makeJob({}, 1);
    expect(selectForStage([j], 'fit-filter', { now: NOW })).toHaveLength(1);
  });

  it('excludes anything already judged, in either direction', () => {
    const good = withStatus(makeJob({ sourceId: 'a' }, 1), 'fit_good');
    const bad = withStatus(makeJob({ sourceId: 'b' }, 1), 'fit_bad');
    expect(selectForStage([good, bad], 'fit-filter', { now: NOW })).toHaveLength(0);
  });

  it('excludes closed jobs even if still nominally "scraped"', () => {
    const j = { ...makeJob({}, 1), closed: true };
    expect(selectForStage([j], 'fit-filter', { now: NOW })).toHaveLength(0);
  });

  it('excludes jobs older than maxAgeDays without spending a token on them', () => {
    const fresh = makeJob({ sourceId: 'a' }, 5);
    const stale = makeJob({ sourceId: 'b' }, 30);
    const selected = selectForStage([fresh, stale], 'fit-filter', { maxAgeDays: 14, now: NOW });
    expect(selected.map((j) => j.sourceId)).toEqual(['a']);
  });

  it('with no maxAgeDays set, age does not exclude anything', () => {
    const old = makeJob({}, 400);
    expect(selectForStage([old], 'fit-filter', { now: NOW })).toHaveLength(1);
  });
});

describe('selectForStage: tracker', () => {
  it('includes only fit_good jobs', () => {
    const scraped = makeJob({ sourceId: 'a' });
    const good = withStatus(makeJob({ sourceId: 'b' }), 'fit_good');
    const bad = withStatus(makeJob({ sourceId: 'c' }), 'fit_bad');
    const tracked = withStatus(withStatus(makeJob({ sourceId: 'd' }), 'fit_good'), 'tracked');

    const selected = selectForStage([scraped, good, bad, tracked], 'tracker', { now: NOW });
    expect(selected.map((j) => j.sourceId)).toEqual(['b']);
  });

  it('ignores maxAgeDays — a job already judged good doesn\'t get re-filtered by age', () => {
    const good = withStatus(makeJob({}, 400), 'fit_good');
    expect(selectForStage([good], 'tracker', { maxAgeDays: 14, now: NOW })).toHaveLength(1);
  });
});

describe('toCleanJob', () => {
  it('keeps only what an LLM stage actually needs', () => {
    const j = withStatus(makeJob(), 'fit_good');
    const clean = toCleanJob(j);
    expect(clean).toMatchObject({
      id: j.id,
      url: j.url,
      title: j.title,
      company: j.company,
      location: 'Melbourne, VIC',
      description: 'Build things.',
    });
    expect(clean).not.toHaveProperty('raw');
    expect(clean).not.toHaveProperty('statusHistory');
    expect(clean).not.toHaveProperty('matchedQueries');
    expect(clean).not.toHaveProperty('seenOn');
    expect(clean).not.toHaveProperty('fingerprint');
    expect(clean).not.toHaveProperty('sourceId');
  });

  it('omits salary and fitReason entirely when absent, rather than null/empty-string', () => {
    const clean = toCleanJob(makeJob());
    expect(clean.salary).toBeUndefined();
    expect(clean.fitReason).toBeUndefined();
    expect(JSON.stringify(clean)).not.toContain('"salary"');
  });

  it('carries fitReason through once the job has been judged good', () => {
    const j = withStatus(makeJob(), 'fit_good');
    expect(toCleanJob(j).fitReason).toBeUndefined(); // no reason was given in this test setup
    const withReason = advanceStatus(makeJob(), 'fit_good', { actor: 'x', reason: 'Java/Spring match' });
    if (!withReason.ok) throw new Error('setup failed');
    expect(toCleanJob(withReason.job).fitReason).toBe('Java/Spring match');
  });
});

describe('selectForStage: cover-letter', () => {
  it('includes only tracked jobs that already have a career profile and no cover letter yet', () => {
    const noProfile = withStatus(withStatus(makeJob({ sourceId: 'a' }), 'fit_good'), 'tracked');
    const withProfile = { ...withStatus(withStatus(makeJob({ sourceId: 'b' }), 'fit_good'), 'tracked'), careerProfile: 'blurb' };
    const alreadyDrafted = {
      ...withStatus(withStatus(makeJob({ sourceId: 'c' }), 'fit_good'), 'tracked'),
      careerProfile: 'blurb',
      coverLetter: 'dear hiring manager...',
    };

    const selected = selectForStage([noProfile, withProfile, alreadyDrafted], 'cover-letter', { now: NOW });
    expect(selected.map((j) => j.sourceId)).toEqual(['b']);
  });
});

describe('selectForStage: documents', () => {
  it('includes only tracked jobs that have both a career profile and a cover letter', () => {
    const neither = withStatus(withStatus(makeJob({ sourceId: 'a' }), 'fit_good'), 'tracked');
    const profileOnly = { ...withStatus(withStatus(makeJob({ sourceId: 'b' }), 'fit_good'), 'tracked'), careerProfile: 'blurb' };
    const both = {
      ...withStatus(withStatus(makeJob({ sourceId: 'c' }), 'fit_good'), 'tracked'),
      careerProfile: 'blurb',
      coverLetter: 'dear hiring manager...',
    };

    const selected = selectForStage([neither, profileOnly, both], 'documents', { now: NOW });
    expect(selected.map((j) => j.sourceId)).toEqual(['c']);
  });

  it('excludes an applied job even with both fields set (regenerating an already-applied job is pointless)', () => {
    const applied = {
      ...withStatus(withStatus(withStatus(makeJob(), 'fit_good'), 'tracked'), 'applied'),
      careerProfile: 'blurb',
      coverLetter: 'dear hiring manager...',
    };
    expect(selectForStage([applied], 'documents', { now: NOW })).toHaveLength(0);
  });
});

describe('relocationNote', () => {
  it('is null for a Melbourne, VIC job (home base)', () => {
    expect(relocationNote(makeJob({ locationRaw: 'Melbourne VIC' }))).toBeNull();
  });

  it('is the state abbreviation for another AU state', () => {
    expect(relocationNote(makeJob({ locationRaw: 'Sydney NSW' }))).toBe('Open to relocation to NSW');
    expect(relocationNote(makeJob({ locationRaw: 'Perth WA' }))).toBe('Open to relocation to WA');
  });

  it('is null for an AU job with no specific state (e.g. AU-wide remote)', () => {
    expect(relocationNote(makeJob({ locationRaw: 'Australia' }))).toBeNull();
  });

  it('is the full country name outside Australia', () => {
    expect(relocationNote(makeJob({ locationRaw: 'Dublin, County Dublin, Ireland' }))).toBe(
      'Open to relocation to Ireland',
    );
    expect(relocationNote(makeJob({ locationRaw: 'Auckland, Auckland, New Zealand' }))).toBe(
      'Open to relocation to New Zealand',
    );
  });
});

describe('toDocumentJob', () => {
  it('flags isInternational true for a non-AU job, false for an AU one', () => {
    const au = toDocumentJob(makeJob({ locationRaw: 'Sydney NSW' }));
    const intl = toDocumentJob(makeJob({ locationRaw: 'Dublin, County Dublin, Ireland' }));
    expect(au.isInternational).toBe(false);
    expect(intl.isInternational).toBe(true);
  });
});

describe('selectForStage: interviewStage excludes a job from every stage', () => {
  it('a job with an interviewStage set is invisible to fit-filter, tracker and cover-letter alike', () => {
    const scraped = { ...makeJob({ sourceId: 'a' }), interviewStage: 'Invalid' };
    const good = { ...withStatus(makeJob({ sourceId: 'b' }), 'fit_good'), interviewStage: 'NA' };
    const tracked = {
      ...withStatus(withStatus(makeJob({ sourceId: 'c' }), 'fit_good'), 'tracked'),
      careerProfile: 'blurb',
      interviewStage: 'Offer',
    };

    expect(selectForStage([scraped], 'fit-filter', { now: NOW })).toHaveLength(0);
    expect(selectForStage([good], 'tracker', { now: NOW })).toHaveLength(0);
    expect(selectForStage([tracked], 'cover-letter', { now: NOW })).toHaveLength(0);
  });
});

describe('toCoverLetterJob', () => {
  it('carries the JD, resume version and any prior clarification note, nothing else', () => {
    const j = { ...withStatus(withStatus(makeJob(), 'fit_good'), 'tracked'), coverLetterNote: 'NEEDS CLARIFICATION: does X count?' };
    const cl = toCoverLetterJob(j);
    expect(cl).toMatchObject({
      id: j.id,
      url: j.url,
      title: j.title,
      company: j.company,
      description: 'Build things.',
      resumeVersion: 'software-engineer',
      previousNote: 'NEEDS CLARIFICATION: does X count?',
    });
    expect(cl).not.toHaveProperty('careerProfile');
    expect(cl).not.toHaveProperty('fitReason');
  });
});
