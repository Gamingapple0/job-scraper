import { describe, it, expect } from 'vitest';
import { checkLiveness, detectLiveness, livenessUrl } from '../src/core/liveness.js';
import { selectForStage } from '../src/core/stage-export.js';
import { BlockedError, HttpError } from '../src/core/http.js';
import { toJob } from '../src/core/normalize.js';
import type { HttpLike, Job, LoggerLike, RawJob } from '../src/core/types.js';

// Snippets copied from live pages captured 2026-10-04.
const SEEK_EXPIRED = '<div>This job is no longer advertised</div><script>{"isExpired":true,"status":"Expired"}</script>';
const SEEK_OPEN = '<div data-automation="jobAdDetails">x</div><script>{"isExpired":false,"status":"Active"}</script>';
const LI_OPEN =
  '<div class="top-card-layout__cta-container"><div data-impression-id="public_jobs_apply-link-offsite_contextual-sign-in-modal"></div></div>';
const LI_CLOSED = '<div class="top-card-layout__cta-container flex"> <!----> <!----> </div>';

const log: LoggerLike = { debug() {}, info() {}, warn() {}, error() {} };

function job(source: 'seek' | 'linkedin', sourceId: string, over: Partial<Job> = {}): Job {
  const raw: RawJob = { sourceId, url: `https://au.seek.com/job/${sourceId}`, title: 'Software Engineer', company: `Co${sourceId}`, locationRaw: 'Sydney NSW' };
  return { ...toJob(raw, source, 'swe', new Date('2026-10-04T00:00:00Z')), ...over };
}

describe('detectLiveness', () => {
  it('reads Seek expiry from page state and visible text', () => {
    expect(detectLiveness('seek', SEEK_EXPIRED)).toBe('expired');
    expect(detectLiveness('seek', SEEK_OPEN)).toBe('open');
    expect(detectLiveness('seek', '<html>captcha</html>')).toBe('unknown');
  });
  it('reads LinkedIn closure as a top card with no apply button', () => {
    expect(detectLiveness('linkedin', LI_OPEN)).toBe('open');
    expect(detectLiveness('linkedin', LI_CLOSED)).toBe('expired');
    expect(detectLiveness('linkedin', '<html>Sign in to LinkedIn</html>')).toBe('unknown');
  });
  it('never closes a job from an unsupported source', () => {
    expect(detectLiveness('indeed', SEEK_EXPIRED)).toBe('unknown');
    expect(livenessUrl({ source: 'indeed' as never, sourceId: '1', url: 'u' })).toBeUndefined();
  });
});

describe('checkLiveness', () => {
  const recorded: Record<string, { liveCheckedAt: string; expiredAt?: string }> = {};
  const deps = (pages: Record<string, string | Error>): Parameters<typeof checkLiveness>[1] => {
    const http: HttpLike = {
      getJson: async () => { throw new Error('unused'); },
      getText: async (url) => {
        const hit = Object.entries(pages).find(([k]) => url.includes(k));
        if (!hit) throw new Error(`no page for ${url}`);
        if (hit[1] instanceof Error) throw hit[1];
        return hit[1];
      },
    };
    return { http, logger: log, record: (id, patch) => { recorded[id] = patch; } };
  };
  const opts = { deadline: Date.now() + 60_000, recheckAfterMs: 6 * 3_600_000 };

  it('marks expired, keeps open, treats 404 as expired, fails open on other errors', async () => {
    const a = job('seek', '1'), b = job('seek', '2'), c = job('linkedin', '3'), d = job('linkedin', '4'), e = job('seek', '5');
    const r = await checkLiveness([a, b, c, d, e], deps({
      '/job/1': SEEK_EXPIRED, '/job/2': SEEK_OPEN, '/jobPosting/3': LI_CLOSED,
      '/jobPosting/4': new HttpError('gone', 404, 'u'), '/job/5': new Error('network down'),
    }), opts);
    expect(r).toMatchObject({ checked: 4, expired: 3, open: 1, unchecked: 1 });
    expect(recorded[a.id]!.expiredAt).toBeDefined();
    expect(recorded[b.id]!.expiredAt).toBeUndefined();
    expect(recorded[e.id]).toBeUndefined();
  });

  it('stops a blocked host but not the other one', async () => {
    const s1 = job('seek', '11'), l1 = job('linkedin', '12'), l2 = job('linkedin', '13');
    const r = await checkLiveness([s1, l1, l2], deps({
      '/job/11': SEEK_OPEN, '/jobPosting/12': new BlockedError('blocked', 429, 'u'), '/jobPosting/13': LI_OPEN,
    }), opts);
    expect(r.blockedHosts).toEqual(['linkedin']);
    expect(r).toMatchObject({ checked: 1, unchecked: 2 });
  });

  it('skips jobs checked recently or already expired, and respects the deadline', async () => {
    const fresh = job('seek', '21', { liveCheckedAt: new Date().toISOString() });
    const gone = job('seek', '22', { expiredAt: '2026-10-01T00:00:00Z' });
    const todo = job('seek', '23');
    const r = await checkLiveness([fresh, gone, todo], deps({ '/job/23': SEEK_OPEN }), opts);
    expect(r.checked).toBe(1);
    const late = await checkLiveness([job('seek', '24')], deps({ '/job/24': SEEK_OPEN }), { ...opts, deadline: Date.now() - 1 });
    expect(late).toMatchObject({ checked: 0, unchecked: 1 });
  });
});

describe('an expired job stays out of every stage', () => {
  it('is excluded from fit-filter and materials selection', () => {
    const live = job('seek', '31');
    const dead = job('seek', '32', { expiredAt: '2026-10-04T00:00:00Z' });
    expect(selectForStage([live, dead], 'fit-filter').map((j) => j.id)).toEqual([live.id]);
  });
});
