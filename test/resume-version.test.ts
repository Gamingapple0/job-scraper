import { describe, it, expect } from 'vitest';
import { classifyResumeVersion, pickResumeVersion } from '../src/core/resume-version.js';

describe('classifyResumeVersion: title decides when it names a testing role', () => {
  it.each([
    // The job that exposed the bug: the old title regex had no term matching "Tester".
    'API Automation Tester',
    'Junior Automation Tester',
    'QA Test Analyst',
    'Test Analyst',
    'Software Test Analyst',
    'Test Engineer',
    'SDET',
    'Software Engineer in Test',
    'QA Automation Engineer (SDET)',
    'Quality Engineer',
    'Software Quality Engineer',
    'Senior Quality Assurance Engineer (Cypress)',
    'Test Automation Analyst',
    'Data Testing Engineer',
  ])('%s -> test-analyst', (title) => {
    expect(pickResumeVersion({ title })).toBe('test-analyst');
  });

  it.each(['Software Engineer', 'Full Stack Developer', 'Java Developer', 'Graduate Software Engineer', 'Frontend Engineer (React)'])(
    '%s -> software-engineer',
    (title) => {
      expect(pickResumeVersion({ title })).toBe('software-engineer');
    },
  );

  it('does not treat the word "contest" or "latest" as testing', () => {
    expect(pickResumeVersion({ title: 'Backend Engineer, Latest Technologies' })).toBe('software-engineer');
  });
});

describe('classifyResumeVersion: "automation" titles are decided by the JD', () => {
  const testingJd =
    'You will write automated tests and own the test automation framework in Playwright and Selenium, ' +
    'author test cases, run regression testing, and work with QA on UAT.';
  const rpaJd = 'Build workflow automation and process automation in UiPath and Power Automate for business process teams. RPA experience required.';

  it('testing-heavy JD -> test-analyst', () => {
    const d = classifyResumeVersion({ title: 'Automation Engineer', description: testingJd });
    expect(d.version).toBe('test-analyst');
    expect(d.reason).toMatch(/testing-heavy/);
  });

  it('RPA / process-automation JD -> software-engineer (the old title regex sent these to the test-analyst resume)', () => {
    expect(pickResumeVersion({ title: 'AI Automation Engineer', description: rpaJd })).toBe('software-engineer');
    expect(pickResumeVersion({ title: 'Intelligence & Automation Engineer', description: rpaJd })).toBe('software-engineer');
  });

  it('a couple of incidental testing words are not enough', () => {
    const jd = 'Automate data pipelines. Some QA involvement and test cases for your own code.';
    expect(pickResumeVersion({ title: 'Tax Data Automation Analyst', description: jd })).toBe('software-engineer');
  });

  it('no description at all falls back to software-engineer rather than guessing', () => {
    expect(pickResumeVersion({ title: 'Automation Engineer' })).toBe('software-engineer');
  });
});
