import { describe, it, expect } from 'vitest';
import { selectForStage, toMaterialsJob, toProfileJob, profileDrifted, coverLetterDrifted } from '../src/core/stage-export.js';
import { toJob } from '../src/core/normalize.js';
import { advanceStatus } from '../src/core/pipeline-status.js';
import type { Job, RawJob } from '../src/core/types.js';

function tracked(title: string, over: Partial<Job> = {}): Job {
  const raw: RawJob = {
    sourceId: title,
    url: 'https://www.linkedin.com/jobs/view/1',
    title,
    company: 'Synechron',
    locationRaw: 'Melbourne VIC',
    postedAtRaw: '2026-09-18T00:00:00Z',
    description: '<p>API test automation.</p>',
  };
  let j = toJob(raw, 'linkedin', 'q', new Date('2026-09-19T00:00:00Z'));
  for (const to of ['fit_good', 'tracked'] as const) {
    const r = advanceStatus(j, to, { actor: 'test' });
    if (!r.ok) throw new Error(r.reason);
    j = r.job;
  }
  return { ...j, ...over };
}

describe('drift: a profile written for the wrong resume version is treated as missing', () => {
  it('an unstamped profile counts as software-engineer, so a test-analyst job re-queues it (the Synechron bug)', () => {
    const j = tracked('API Automation Tester', { careerProfile: 'SE-flavoured profile', coverLetter: 'letter' });
    expect(profileDrifted(j)).toBe(true);
    expect(coverLetterDrifted(j)).toBe(true);
    expect(selectForStage([j], 'career-profile')).toHaveLength(1);
    expect(selectForStage([j], 'materials')).toHaveLength(1);
    expect(selectForStage([j], 'documents')).toHaveLength(0);
  });

  it('a profile stamped with the job\'s own version is current and flows through to documents', () => {
    const j = tracked('API Automation Tester', {
      careerProfile: 'TA profile',
      careerProfileVersion: 'test-analyst',
      coverLetter: 'letter',
      coverLetterVersion: 'test-analyst',
    });
    expect(profileDrifted(j)).toBe(false);
    expect(selectForStage([j], 'materials')).toHaveLength(0);
    expect(selectForStage([j], 'documents')).toHaveLength(1);
  });

  it('an unstamped profile on a software-engineer job is left alone', () => {
    const j = tracked('Software Engineer', { careerProfile: 'p', coverLetter: 'l' });
    expect(profileDrifted(j)).toBe(false);
    expect(selectForStage([j], 'materials')).toHaveLength(0);
    expect(selectForStage([j], 'documents')).toHaveLength(1);
  });

  it('the cover-letter stage waits for a current profile', () => {
    const drifted = tracked('API Automation Tester', { careerProfile: 'SE profile' });
    const current = tracked('API Automation Tester', { careerProfile: 'TA profile', careerProfileVersion: 'test-analyst' });
    expect(selectForStage([drifted], 'cover-letter')).toHaveLength(0);
    expect(selectForStage([current], 'cover-letter')).toHaveLength(1);
  });
});

describe('selectForStage: materials', () => {
  it('is the union of the profile and cover-letter stages', () => {
    const neither = tracked('Software Engineer');
    const letterOnly = tracked('Software Engineer', { careerProfile: 'p' });
    const done = tracked('Software Engineer', { careerProfile: 'p', coverLetter: 'l' });
    const closed = tracked('Software Engineer', { closed: true });
    const staged = tracked('Software Engineer', { interviewStage: 'Offer' });
    expect(selectForStage([neither, letterOnly, done, closed, staged], 'materials')).toEqual([neither, letterOnly]);
  });

  it('does not re-send a job the profile step flagged as disqualifying', () => {
    const dq = tracked('Software Engineer', { profileNote: 'DISQUALIFYING REQUIREMENT (visa) review manually.' });
    const clarify = tracked('Software Engineer', { profileNote: 'NEEDS CLARIFICATION: any Rust?' });
    expect(selectForStage([dq], 'materials')).toHaveLength(0);
    expect(selectForStage([dq], 'career-profile')).toHaveLength(0);
    expect(selectForStage([clarify], 'materials')).toHaveLength(1);
  });
});

describe('toMaterialsJob / toProfileJob', () => {
  it('carries the correct base resume file and what is still needed', () => {
    const both = toMaterialsJob(tracked('API Automation Tester'));
    expect(both).toMatchObject({ resumeVersion: 'test-analyst', resumeFile: 'Claude outputs/resume-test-analyst.md', needs: ['career_profile', 'cover_letter'] });
    expect(both).not.toHaveProperty('careerProfile');

    const letterOnly = toMaterialsJob(tracked('Software Engineer', { careerProfile: 'existing profile' }));
    expect(letterOnly).toMatchObject({ resumeFile: 'Claude outputs/resume.md', needs: ['cover_letter'], careerProfile: 'existing profile' });

    const redo = toMaterialsJob(tracked('API Automation Tester', { careerProfile: 'SE profile', coverLetter: 'letter' }));
    expect(redo.redo).toMatch(/software-engineer resume; this job needs test-analyst/);
    expect(redo).not.toHaveProperty('careerProfile');

    expect(toProfileJob(tracked('Test Engineer'))).toMatchObject({ resumeVersion: 'test-analyst', resumeFile: 'Claude outputs/resume-test-analyst.md' });
  });
});
