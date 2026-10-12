import { describe, it, expect } from 'vitest';
import { lintCareerProfile, lintCoverLetter, titleCandidates, wordCount } from '../src/core/tailoring-lint.js';

const words = (n: number, seed = 'word') => Array.from({ length: n }, (_, i) => `${seed}${i % 7}`).join(' ');

const goodProfile = `Test analyst turned engineer targeting the API Automation Tester role Synechron is hiring for. ${words(75)}.`;
const goodLetter = [
  `Owning test automation from zero coverage is work I have already done, which is why Synechron's role fits. ${words(60)}.`,
  `${words(90)}.`,
  `${words(80)}.`,
  `${words(30)}. I would welcome a conversation.`,
].join('\n\n');

describe('lintCareerProfile', () => {
  it('accepts a single paragraph that names the company and is a sensible length', () => {
    expect(lintCareerProfile(goodProfile, 'Synechron')).toEqual([]);
  });

  it('flags an em dash, a line break, a bullet, missing company and a wrong length', () => {
    expect(lintCareerProfile(goodProfile.replace('turned', '— turned'), 'Synechron').join()).toMatch(/em dash/);
    expect(lintCareerProfile(`${goodProfile}\nSecond line`, 'Synechron').join()).toMatch(/single paragraph/);
    expect(lintCareerProfile(`- ${goodProfile}`, 'Synechron').join()).toMatch(/bullets/);
    expect(lintCareerProfile(goodProfile, 'Acme Corp').join()).toMatch(/never mentions the company/);
    expect(lintCareerProfile('Synechron. Too short.', 'Synechron').join()).toMatch(/words/);
  });

  it('allows a plain hyphen and an en dash inside a range', () => {
    expect(lintCareerProfile(goodProfile.replace('turned', 'turned (2019–2021, full-stack)'), 'Synechron')).toEqual([]);
  });

  it('matches the company by its meaningful first word, ignoring legal suffixes', () => {
    expect(lintCareerProfile(goodProfile, 'Synechron Pty Ltd')).toEqual([]);
  });
});

describe('exact job title (ATS)', () => {
  it('requires the posting title or one of its clauses, verbatim', () => {
    expect(lintCareerProfile(goodProfile, 'Synechron', 'API Automation Tester')).toEqual([]);
    expect(lintCareerProfile(goodProfile, 'Synechron', 'Test Analyst - Payments (Contract)')).toEqual([]);
    expect(lintCareerProfile(goodProfile, 'Synechron', 'QA Engineer').join()).toMatch(/exact job title/);
  });

  it('splits bracket noise and clauses off the title', () => {
    expect(titleCandidates('Sales Assistant - Chadstone (Christmas Casual)')).toEqual(['Sales Assistant - Chadstone', 'Sales Assistant', 'Chadstone']);
  });
});

describe('lintCoverLetter', () => {
  it('accepts a 4 paragraph letter of about 300 words that names the company', () => {
    expect(wordCount(goodLetter)).toBeGreaterThan(235);
    expect(lintCoverLetter(goodLetter, 'Synechron')).toEqual([]);
  });

  it('flags a salutation, a sign-off, placeholders, list lines and the generic opener', () => {
    expect(lintCoverLetter(`Dear Hiring Team,\n\n${goodLetter}`, 'Synechron').join()).toMatch(/salutation/);
    expect(lintCoverLetter(`${goodLetter}\n\nBest regards,\nAnshu Madhikarmi`, 'Synechron').join()).toMatch(/sign-off/);
    expect(lintCoverLetter(goodLetter.replace('Synechron', '[Company]'), 'Synechron').join()).toMatch(/placeholder/);
    expect(lintCoverLetter(`${goodLetter}\n\n- extra bullet here`, 'Synechron').join()).toMatch(/bullets/);
    expect(lintCoverLetter(goodLetter.replace(/^Owning/, 'I am writing to express my interest, owning'), 'Synechron').join()).toMatch(/generic/);
  });

  it('flags a letter that is far too short or has no paragraph breaks', () => {
    expect(lintCoverLetter('Synechron is great. '.repeat(10), 'Synechron').join()).toMatch(/words/);
    expect(lintCoverLetter(goodLetter.replace(/\n\n/g, ' '), 'Synechron').join()).toMatch(/paragraph/);
  });
});

describe('framework v2: no exact-title rule on the main tracker', () => {
  it('main profile accepts a profile without the posting title; only titleHeadline profiles require it', async () => {
    const { PipelineProfile } = await import('../src/core/profile.js');
    expect(new PipelineProfile().lintProfile(goodProfile, { company: 'Synechron', title: 'QA Engineer' })).toEqual([]);
  });
});
