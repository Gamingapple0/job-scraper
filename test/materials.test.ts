import { describe, it, expect } from 'vitest';
import { applyMaterials, MaterialsVerdictsSchema } from '../src/core/materials.js';
import { toJob } from '../src/core/normalize.js';
import type { Job, RawJob } from '../src/core/types.js';
import type { ResumeVersion } from '../src/core/resume-version.js';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 9}`).join(' ');
const profile = (company: string) => `Engineer aimed at what ${company} is hiring for. ${words(75)}.`;
const letter = (company: string) =>
  [`Opening line about ${company} and the role. ${words(55)}.`, `${words(90)}.`, `${words(80)}.`, `${words(35)}. Thank you.`].join('\n\n');

function job(title: string, company = 'Synechron'): Job {
  const raw: RawJob = {
    sourceId: title,
    url: 'https://example.com/job/1',
    title,
    company,
    locationRaw: 'Melbourne VIC',
    postedAtRaw: '2026-09-18T00:00:00Z',
    description: '<p>Do the work.</p>',
  };
  return toJob(raw, 'linkedin', 'q', new Date('2026-09-19T00:00:00Z'));
}

/** Minimal in-memory stand-in for the parts of Store that applyMaterials touches. */
function fakeStore(jobs: Job[]) {
  const byId = new Map(jobs.map((j) => [j.id, { ...j }]));
  return {
    byId,
    get: (id: string) => byId.get(id),
    setProfile(id: string, patch: { careerProfile: string; version: ResumeVersion } | { profileNote: string }) {
      const j = byId.get(id);
      if (!j) return { ok: false as const, reason: 'unknown id' as const };
      if ('careerProfile' in patch) {
        j.careerProfile = patch.careerProfile;
        j.careerProfileVersion = patch.version;
        j.profileNote = undefined;
      } else j.profileNote = patch.profileNote;
      return { ok: true as const };
    },
    setCoverLetter(id: string, patch: { coverLetter: string; version: ResumeVersion } | { coverLetterNote: string }) {
      const j = byId.get(id);
      if (!j) return { ok: false as const, reason: 'unknown id' as const };
      if ('coverLetter' in patch) {
        j.coverLetter = patch.coverLetter;
        j.coverLetterVersion = patch.version;
        j.coverLetterNote = undefined;
      } else j.coverLetterNote = patch.coverLetterNote;
      return { ok: true as const };
    },
  };
}

describe('applyMaterials: the resume_version guard', () => {
  it('rejects a profile written from the wrong base resume (the original bug) and writes nothing', () => {
    const j = job('API Automation Tester');
    const store = fakeStore([j]);
    const report = applyMaterials(store, [
      { id: j.id, resume_version: 'software-engineer', career_profile: profile('Synechron'), cover_letter: letter('Synechron') },
    ]);
    expect(report.profilesWritten).toBe(0);
    expect(report.skipped[0].reasons.join()).toMatch(/mismatch.*test-analyst/);
    expect(store.byId.get(j.id)?.careerProfile).toBeUndefined();
  });

  it('accepts the right base and stamps the version on both pieces', () => {
    const j = job('API Automation Tester');
    const store = fakeStore([j]);
    const report = applyMaterials(store, [
      { id: j.id, resume_version: 'test-analyst', career_profile: profile('Synechron'), cover_letter: letter('Synechron') },
    ]);
    expect(report).toMatchObject({ profilesWritten: 1, lettersWritten: 1, skipped: [] });
    const saved = store.byId.get(j.id)!;
    expect(saved.careerProfileVersion).toBe('test-analyst');
    expect(saved.coverLetterVersion).toBe('test-analyst');
  });
});

describe('applyMaterials: lint and dependencies', () => {
  it('rejects a profile with an em dash and does not apply the letter that depends on it', () => {
    const j = job('Software Engineer');
    const store = fakeStore([j]);
    const report = applyMaterials(store, [
      { id: j.id, resume_version: 'software-engineer', career_profile: profile('Synechron').replace('Engineer', 'Engineer —'), cover_letter: letter('Synechron') },
    ]);
    expect(report.profilesWritten + report.lettersWritten).toBe(0);
    expect(report.skipped.map((s) => s.piece)).toEqual(['career_profile', 'cover_letter']);
  });

  it('keeps a good profile when only the letter fails lint', () => {
    const j = job('Software Engineer');
    const store = fakeStore([j]);
    const report = applyMaterials(store, [
      { id: j.id, resume_version: 'software-engineer', career_profile: profile('Synechron'), cover_letter: 'Far too short for Synechron.' },
    ]);
    expect(report.profilesWritten).toBe(1);
    expect(report.lettersWritten).toBe(0);
    expect(store.byId.get(j.id)?.careerProfile).toBeTruthy();
    expect(store.byId.get(j.id)?.coverLetter).toBeUndefined();
  });

  it('a letter-only entry needs a current profile already on the job', () => {
    const j = job('Software Engineer');
    const store = fakeStore([j]);
    const noProfile = applyMaterials(store, [{ id: j.id, resume_version: 'software-engineer', cover_letter: letter('Synechron') }]);
    expect(noProfile.skipped[0].reasons.join()).toMatch(/no current career profile/);

    store.byId.get(j.id)!.careerProfile = profile('Synechron');
    const withProfile = applyMaterials(store, [{ id: j.id, resume_version: 'software-engineer', cover_letter: letter('Synechron') }]);
    expect(withProfile.lettersWritten).toBe(1);
  });

  it('records clarification and disqualification notes without touching the text fields', () => {
    const a = job('Software Engineer', 'Alpha');
    const b = job('Backend Developer', 'Beta');
    const store = fakeStore([a, b]);
    const report = applyMaterials(store, [
      { id: a.id, resume_version: 'software-engineer', error: 'needs_clarification', questions: ['Any Rust?'] },
      { id: b.id, resume_version: 'software-engineer', error: 'disqualifying_requirement' },
    ]);
    expect(report.flagged).toBe(2);
    expect(store.byId.get(a.id)?.profileNote).toMatch(/NEEDS CLARIFICATION: Any Rust\?/);
    expect(store.byId.get(b.id)?.profileNote).toMatch(/^DISQUALIFYING/);
  });

  it('dry run validates but writes nothing', () => {
    const j = job('Software Engineer');
    const store = fakeStore([j]);
    const report = applyMaterials(store, [{ id: j.id, resume_version: 'software-engineer', career_profile: profile('Synechron') }], { dryRun: true });
    expect(report.profilesWritten).toBe(1);
    expect(store.byId.get(j.id)?.careerProfile).toBeUndefined();
  });
});

describe('MaterialsVerdictsSchema', () => {
  it('requires resume_version, something to apply, and questions for a clarification', () => {
    expect(MaterialsVerdictsSchema.safeParse([{ id: 'a', career_profile: 'x' }]).success).toBe(false);
    expect(MaterialsVerdictsSchema.safeParse([{ id: 'a', resume_version: 'software-engineer' }]).success).toBe(false);
    expect(MaterialsVerdictsSchema.safeParse([{ id: 'a', resume_version: 'software-engineer', error: 'needs_clarification' }]).success).toBe(false);
    expect(MaterialsVerdictsSchema.safeParse([{ id: 'a', resume_version: 'nonsense', career_profile: 'x' }]).success).toBe(false);
    expect(MaterialsVerdictsSchema.safeParse([{ id: 'a', resume_version: 'test-analyst', career_profile: 'x' }]).success).toBe(true);
  });
});
