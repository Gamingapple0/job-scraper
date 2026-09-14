import { describe, it, expect } from 'vitest';
import { canTransition, advanceStatus } from '../src/core/pipeline-status.js';
import { toJob } from '../src/core/normalize.js';
import type { RawJob } from '../src/core/types.js';

function job() {
  const raw: RawJob = {
    sourceId: '1',
    url: 'https://example.com/job/1',
    title: 'Software Engineer',
    company: 'Acme',
    locationRaw: 'Melbourne VIC',
    raw: {},
  };
  return toJob(raw, 'seek', 'swe');
}

describe('canTransition', () => {
  it('allows the documented forward moves', () => {
    expect(canTransition('scraped', 'fit_good')).toBe(true);
    expect(canTransition('scraped', 'fit_bad')).toBe(true);
    expect(canTransition('fit_good', 'tracked')).toBe(true);
    expect(canTransition('fit_good', 'applied')).toBe(true);
    expect(canTransition('tracked', 'applied')).toBe(true);
  });

  it('refuses everything else, including skipping backwards', () => {
    expect(canTransition('fit_bad', 'scraped')).toBe(false);
    expect(canTransition('fit_bad', 'fit_good')).toBe(false);
    expect(canTransition('tracked', 'scraped')).toBe(false);
    expect(canTransition('tracked', 'fit_good')).toBe(false);
    expect(canTransition('applied', 'scraped')).toBe(false);
    expect(canTransition('applied', 'tracked')).toBe(false);
  });

  it('treats fit_bad and applied as terminal: nothing moves out of them', () => {
    expect(canTransition('fit_bad', 'fit_bad')).toBe(false);
    for (const to of ['scraped', 'fit_good', 'fit_bad', 'tracked', 'applied'] as const) {
      expect(canTransition('applied', to)).toBe(false);
    }
  });
});

describe('advanceStatus', () => {
  it('advances and records the event', () => {
    const j = job();
    const res = advanceStatus(j, 'fit_good', { actor: 'fit-filter-agent', reason: 'Strong Java/Spring match' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.job.pipelineStatus).toBe('fit_good');
    expect(res.job.fitReason).toBe('Strong Java/Spring match');
    expect(res.job.statusHistory).toHaveLength(1);
    expect(res.job.statusHistory[0]).toMatchObject({
      from: 'scraped',
      to: 'fit_good',
      actor: 'fit-filter-agent',
    });
  });

  it('never mutates the input job', () => {
    const j = job();
    advanceStatus(j, 'fit_good', { actor: 'x' });
    expect(j.pipelineStatus).toBe('scraped');
    expect(j.statusHistory).toHaveLength(0);
  });

  it('refuses a disallowed transition and explains why', () => {
    const j = job();
    const good = advanceStatus(j, 'fit_good', { actor: 'x' });
    if (!good.ok) throw new Error('setup failed');
    const res = advanceStatus(good.job, 'scraped', { actor: 'x' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.reason).toContain('cannot move from fit_good to scraped');
  });

  it('refuses a no-op transition to the same status', () => {
    const j = job();
    const res = advanceStatus(j, 'scraped', { actor: 'x' });
    expect(res.ok).toBe(false);
  });

  it('chains realistically: scraped -> fit_good -> tracked -> applied', () => {
    let j = job();
    for (const [to, actor] of [
      ['fit_good', 'fit-filter-agent'],
      ['tracked', 'tracker-agent'],
      ['applied', 'sheet-sync'],
    ] as const) {
      const res = advanceStatus(j, to, { actor });
      if (!res.ok) throw new Error(`unexpected refusal moving to ${to}: ${res.reason}`);
      j = res.job;
    }
    expect(j.pipelineStatus).toBe('applied');
    expect(j.statusHistory.map((e) => e.to)).toEqual(['fit_good', 'tracked', 'applied']);
  });
});
