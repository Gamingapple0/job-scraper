import { afterEach, describe, it, expect } from 'vitest';
import { activeProfile, pickResumeVersion, PipelineProfile, setActiveProfile } from '../src/core/profile.js';
import { ChristmasCasualProfile } from '../src/variants/christmas-casual.js';
import { ConfigSchema } from '../src/core/config.js';
import { headlineTitle, resumeDocFor } from '../src/core/stage-export.js';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 9}`).join(' ');
const job = { title: 'Christmas Casual Sales Assistant', company: 'Myer' };
const profile = `Christmas Casual Sales Assistant available weekends and evenings for Myer. ${words(55)}.`;
const letter = [`Myer at Christmas is busy. ${words(50)}.`, `${words(60)}.`, `I am available weekends, evenings and public holidays. ${words(40)}.`].join('\n\n');

afterEach(() => setActiveProfile(new PipelineProfile()));

describe('ChristmasCasualProfile', () => {
  it('overrides the resume choice, file and doc; the main profile is untouched', () => {
    expect(pickResumeVersion({ title: 'QA Tester' })).toBe('test-analyst');
    setActiveProfile(new ChristmasCasualProfile());
    expect(pickResumeVersion({ title: 'QA Tester' })).toBe('christmas-casual');
    expect(activeProfile().resumeFile('christmas-casual')).toMatch(/christmas/);
    const cfg = ConfigSchema.parse({ pipeline: { documentsResumeDocs: { christmasCasual: 'XMAS_DOC' } } });
    expect(resumeDocFor('christmas-casual', cfg)).toBe('XMAS_DOC');
    expect(activeProfile().hasIntlSheet).toBe(false);
  });

  it('keeps the base lint and adds an availability rule with shorter lengths', () => {
    const p = new ChristmasCasualProfile();
    expect(p.lintProfile(profile, job)).toEqual([]);
    expect(p.lintLetter(letter, job)).toEqual([]);
    expect(p.lintProfile(profile.replace('available weekends and evenings', 'keen'), job).join()).toMatch(/availability/);
    expect(p.lintProfile(profile.replace('Christmas Casual Sales Assistant', 'Retail worker'), job).join()).toMatch(/exact job title/);
    expect(p.lintProfile(`${profile} ${words(80)}`, job).join()).toMatch(/words/);
  });
});

describe('headlineTitle', () => {
  it('keeps the posting words, drops bracket noise, and shortens only when too long', () => {
    expect(headlineTitle('Sales Assistant (Christmas Casual)')).toBe('Sales Assistant');
    expect(headlineTitle('Software Engineer')).toBe('Software Engineer');
    expect(headlineTitle('Assoc Delivery Cons - App/Dev, Associate to Consultant ProServe Shared Delivery')).toBe('Assoc Delivery Cons');
  });
});
