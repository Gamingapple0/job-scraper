import { describe, it, expect } from 'vitest';
import { sheetHeaders, colIndex, jobToRow, decideTextCell, type SheetsConfig } from '../src/core/google-sheets.js';
import type { CleanJob } from '../src/core/stage-export.js';

const auCfg: SheetsConfig = {
  spreadsheetId: 'au',
  sheetName: 'Tracker',
  oauthClientPath: '',
  oauthTokenPath: '',
};
const intlCfg: SheetsConfig = { ...auCfg, spreadsheetId: 'intl', includeCountry: true };

describe('sheetHeaders', () => {
  it('AU layout: no Country, no Technical Skills, requested column order', () => {
    expect(sheetHeaders(auCfg)).toEqual([
      'Job ID', 'Title', 'Company', 'Location',
      'URL', 'Applied/Closed', 'Career Profile', 'Cover Letter', 'Fit Reason',
      'Date Added', 'Date Posted', 'Tags', 'Salary', 'Notes', 'Stages', 'Apply Method',
    ]);
  });

  it('international layout: same order with Country right after Location', () => {
    const headers = sheetHeaders(intlCfg);
    expect(headers).toContain('Country');
    expect(headers).not.toContain('Technical Skills');
    expect(headers.indexOf('Country')).toBe(headers.indexOf('Location') + 1);
  });
});

describe('colIndex', () => {
  it('finds every column by name for both layouts', () => {
    const au = colIndex(sheetHeaders(auCfg));
    expect(au.jobId).toBe(0);
    expect(au.country).toBe(-1); // no Country column on the AU layout
    expect(au.stages).toBe(sheetHeaders(auCfg).length - 2);
    expect(au.applyMethod).toBe(sheetHeaders(auCfg).length - 1); // always the last column

    const intl = colIndex(sheetHeaders(intlCfg));
    expect(intl.country).toBe(4);
    expect(intl.url).toBe(5);
  });
});

describe('jobToRow', () => {
  const job: CleanJob = {
    id: 'abc123',
    url: 'https://example.com/job/1',
    title: 'Software Engineer',
    company: 'Acme',
    location: 'Melbourne, VIC',
    country: 'AU',
    postedAt: '2026-09-01',
    salary: '$100,000/year',
    tags: ['react', 'typescript'],
    fitReason: 'Good match',
  };

  it('places every field in its header-named column, blank for agent/manual columns not yet filled', () => {
    const headers = sheetHeaders(auCfg);
    const row = jobToRow(job, '2026-09-18', headers);
    const byName = Object.fromEntries(headers.map((h, i) => [h, row[i]]));
    expect(byName['Job ID']).toBe('abc123');
    expect(byName.Location).toBe('Melbourne, VIC');
    expect(byName['Date Posted']).toBe('2026-09-01');
    expect(byName['Date Added']).toBe('2026-09-18');
    expect(byName.Tags).toBe('react, typescript');
    expect(byName['Fit Reason']).toBe('Good match');
    expect(byName['Applied/Closed']).toBe('');
    expect(byName['Career Profile']).toBe('');
    expect(byName['Cover Letter']).toBe('');
    expect(byName.Notes).toBe('');
    expect(byName.Stages).toBe('');
    expect(byName['Apply Method']).toBe(''); // unknown until scraped (SEEK) or checked (LinkedIn)
    expect(row).toHaveLength(headers.length);
  });

  it('labels the Apply Method column from applyMethod', () => {
    const headers = sheetHeaders(auCfg);
    const last = (j: CleanJob) => jobToRow(j, '2026-09-18', headers)[headers.length - 1];
    expect(last({ ...job, applyMethod: 'easy_apply' })).toBe('Easy Apply');
    expect(last({ ...job, applyMethod: 'quick_apply' })).toBe('Quick Apply');
    expect(last({ ...job, applyMethod: 'external' })).toBe('External');
  });

  it('writes Country only on the international layout', () => {
    const auRow = jobToRow(job, '2026-09-18', sheetHeaders(auCfg));
    expect(auRow).toHaveLength(sheetHeaders(auCfg).length);

    const intlHeaders = sheetHeaders(intlCfg);
    const intlRow = jobToRow(job, '2026-09-18', intlHeaders);
    expect(intlRow[intlHeaders.indexOf('Country')]).toBe('AU');
  });
});

describe('decideTextCell', () => {
  it('pushes into an empty cell, does nothing when both sides agree or are empty', () => {
    expect(decideTextCell('profile', '', undefined)).toBe('push');
    expect(decideTextCell('profile', 'profile', undefined)).toBe('none');
    expect(decideTextCell(undefined, '', undefined)).toBe('none');
  });

  it('pushes a regenerated text over a stale cell (sheet still equals the last snapshot)', () => {
    expect(decideTextCell('new profile', 'old profile', 'old profile')).toBe('push');
  });

  it('pulls back a hand edit (sheet no longer equals the snapshot) so Anshu always wins', () => {
    expect(decideTextCell('new profile', 'Anshu typed this', 'old profile')).toBe('pull');
  });

  it('with no snapshot recorded, a differing non-empty cell is treated as a hand edit', () => {
    expect(decideTextCell('json text', 'sheet text', undefined)).toBe('pull');
  });

  it('ignores surrounding whitespace', () => {
    expect(decideTextCell('profile ', ' profile', undefined)).toBe('none');
  });
});
