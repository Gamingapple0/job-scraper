import { describe, it, expect } from 'vitest';
import {
  sanitizeFilenamePart,
  isWeirdCompanyName,
  companyAcronym,
  buildResumeFileName,
  buildCoverLetterFileName,
  resumeDocFor,
  MAX_FILENAME_LENGTH,
} from '../src/core/stage-export.js';
import type { Config } from '../src/core/config.js';

describe('sanitizeFilenamePart', () => {
  it('replaces every special character (parens, slash, comma, ...) with underscores and collapses whitespace', () => {
    expect(sanitizeFilenamePart('Full Stack Developer (Java/React)')).toBe('Full_Stack_Developer_Java_React');
    expect(sanitizeFilenamePart('  Software  Engineer  ')).toBe('Software_Engineer');
    expect(sanitizeFilenamePart('Associate, Consultant (A2C)')).toBe('Associate_Consultant_A2C');
  });

  it('replaces & and - with underscores instead of dropping them', () => {
    expect(sanitizeFilenamePart('AT&T')).toBe('AT_T');
    expect(sanitizeFilenamePart('Xero - Payments')).toBe('Xero_Payments');
    expect(sanitizeFilenamePart('R&D - Full-Stack Engineer')).toBe('R_D_Full_Stack_Engineer');
  });

  it('never leaves doubled-up underscores from adjacent special characters', () => {
    expect(sanitizeFilenamePart('App/Dev, Associate')).toBe('App_Dev_Associate');
  });
});

describe('isWeirdCompanyName', () => {
  it('is false for ordinary short company names', () => {
    expect(isWeirdCompanyName('Google')).toBe(false);
    expect(isWeirdCompanyName('JDR Software')).toBe(false);
    expect(isWeirdCompanyName('Trideca Pty Ltd')).toBe(false);
  });

  it('is true once a name is long or has more than 4 words', () => {
    expect(isWeirdCompanyName('A Very Long Recruitment Agency Consortium Group')).toBe(true);
    expect(isWeirdCompanyName('Some Extremely Long Company Name That Nobody Wants In A Filename')).toBe(true);
  });
});

describe('companyAcronym', () => {
  it('takes the uppercased first letter of each word', () => {
    expect(companyAcronym('Happy Connecting Group Pty Ltd')).toBe('HCGPL');
  });
});

describe('buildResumeFileName / buildCoverLetterFileName', () => {
  it('follows the Anshu_Madhikarmi_<Company>_<Role>_<Kind> convention', () => {
    expect(buildResumeFileName('Software Engineer', 'Google')).toBe('Anshu_Madhikarmi_Google_Software_Engineer_Resume.docx');
    expect(buildCoverLetterFileName('Software Engineer', 'Google')).toBe(
      'Anshu_Madhikarmi_Google_Software_Engineer_Cover_Letter.docx',
    );
  });

  it('acronyms a weird company name instead of spelling it out', () => {
    const name = buildResumeFileName('Full Stack Developer', 'A Very Long Recruitment Agency Consortium Group');
    expect(name).toBe('Anshu_Madhikarmi_AVLRACG_Full_Stack_Developer_Resume.docx');
  });

  it('turns & in a short company name into an underscore rather than dropping it', () => {
    expect(buildResumeFileName('Software Engineer', 'H&M')).toBe('Anshu_Madhikarmi_H_M_Software_Engineer_Resume.docx');
  });

  it('shortens a long, classification-heavy title to its first clause instead of spelling it all out', () => {
    const title = 'Assoc Delivery Cons - App/Dev, Associate to Consultant (A2C) ProServe Shared Delivery (SDT)';
    expect(buildResumeFileName(title, 'JDR Software')).toBe('Anshu_Madhikarmi_JDR_Software_Assoc_Delivery_Cons_Resume.docx');
  });

  it('keeps a short, clean title in full even though it could have been clause-split', () => {
    expect(buildResumeFileName('Backend Engineer', 'Xero')).toBe('Anshu_Madhikarmi_Xero_Backend_Engineer_Resume.docx');
  });

  it('never produces a file name longer than MAX_FILENAME_LENGTH, even for a long title with no natural clause break', () => {
    const title = 'Senior Full Stack Software Engineer Specializing In Cloud Native Distributed Systems Architecture';
    const resume = buildResumeFileName(title, 'A Very Long Recruitment Agency Consortium Group');
    const coverLetter = buildCoverLetterFileName(title, 'A Very Long Recruitment Agency Consortium Group');
    expect(resume.length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH);
    expect(coverLetter.length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH);
    expect(resume).not.toMatch(/_{2,}/);
    expect(resume).not.toMatch(/_\./);
  });

  it('gives the resume and its cover letter the identical title token', () => {
    const title = 'Assoc Delivery Cons - App/Dev, Associate to Consultant (A2C) ProServe Shared Delivery (SDT)';
    const resume = buildResumeFileName(title, 'Genesys');
    const coverLetter = buildCoverLetterFileName(title, 'Genesys');
    expect(resume.replace(/_Resume\.docx$/, '')).toBe(coverLetter.replace(/_Cover_Letter\.docx$/, ''));
  });
});

describe('resumeDocFor', () => {
  const cfg = {
    pipeline: { documentsResumeDocs: { softwareEngineer: 'SWE_DOC_ID', testAnalyst: 'QA_DOC_ID' } },
  } as Config;

  it('maps each resume version to its own Google Doc', () => {
    expect(resumeDocFor('test-analyst', cfg)).toBe('QA_DOC_ID');
    expect(resumeDocFor('software-engineer', cfg)).toBe('SWE_DOC_ID');
  });
});
