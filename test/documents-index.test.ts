import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  companyFolderName,
  companyKey,
  resolveCompanyFolder,
  pickFileNames,
  inputsHash,
  emptyIndex,
  findActiveBatch,
  newBatchName,
  batchRootWindows,
  INDEX_FILE,
  type DocumentInputs,
} from '../src/core/documents-index.js';

describe('companyFolderName', () => {
  it('keeps the company name readable and strips what Windows rejects', () => {
    expect(companyFolderName('Synechron')).toBe('Synechron');
    expect(companyFolderName('JDR Software')).toBe('JDR Software');
    expect(companyFolderName('AT&T')).toBe('AT&T');
    expect(companyFolderName('Acme: Payments/Platform?')).toBe('Acme PaymentsPlatform');
    expect(companyFolderName('  Trailing dot Inc. ')).toBe('Trailing dot Inc');
  });

  it('caps the length and never returns an empty or reserved name', () => {
    expect(companyFolderName('A'.repeat(200)).length).toBeLessThanOrEqual(60);
    expect(companyFolderName('???')).toBe('Unknown company');
    expect(companyFolderName('CON')).toBe('CON Co');
  });
});

describe('resolveCompanyFolder: keep adding to a company that already has a folder', () => {
  it('reuses an existing folder regardless of case or legal suffix', () => {
    expect(resolveCompanyFolder(['Synechron', 'Akkodis'], 'synechron')).toBe('Synechron');
    expect(resolveCompanyFolder(['Atlassian'], 'Atlassian Pty Ltd')).toBe('Atlassian');
    expect(resolveCompanyFolder(['Woolworths Group'], 'Woolworths')).toBe('Woolworths Group');
  });

  it('starts a new folder for an unseen company', () => {
    expect(resolveCompanyFolder(['Synechron'], 'Munro Footwear Group')).toBe('Munro Footwear Group');
    expect(resolveCompanyFolder([], 'Akkodis')).toBe('Akkodis');
  });

  it('two different companies do not share a folder', () => {
    expect(companyKey('Origin')).not.toBe(companyKey('Orion'));
    expect(resolveCompanyFolder(['Origin'], 'Orion')).toBe('Orion');
  });

  it('does not mistake an old timestamp folder for a company', () => {
    expect(resolveCompanyFolder(['2026-09-19-13-40-45'], 'Synechron')).toBe('Synechron');
  });
});

describe('pickFileNames', () => {
  const resume = 'Anshu_Madhikarmi_Synechron_API_Automation_Tester_Resume.pdf';
  const cover = 'Anshu_Madhikarmi_Synechron_API_Automation_Tester_Cover_Letter.pdf';

  it('uses the plain names when nothing else owns them', () => {
    expect(pickFileNames(emptyIndex('C:\\x'), 'job-a', 'Synechron', resume, cover)).toEqual({ resume, coverLetter: cover });
  });

  it('keeps a job\'s own names on a rebuild', () => {
    const index = emptyIndex('C:\\x');
    index.jobs['job-a'] = { company: 'Synechron', title: 't', folder: 'Synechron', resume, coverLetter: cover, resumeVersion: 'test-analyst', hash: 'h', generatedAt: '' };
    expect(pickFileNames(index, 'job-a', 'Synechron', resume, cover)).toEqual({ resume, coverLetter: cover });
  });

  it('adds a short job-id suffix when a different job already owns the name in that folder', () => {
    const index = emptyIndex('C:\\x');
    index.jobs['job-a'] = { company: 'Synechron', title: 't', folder: 'synechron', resume, coverLetter: cover, resumeVersion: 'test-analyst', hash: 'h', generatedAt: '' };
    const names = pickFileNames(index, 'zzzzzz-second', 'Synechron', resume, cover);
    expect(names.resume).toBe('Anshu_Madhikarmi_Synechron_API_Automation_Tester_zzzzzz_Resume.pdf');
    expect(names.coverLetter).toBe('Anshu_Madhikarmi_Synechron_API_Automation_Tester_zzzzzz_Cover_Letter.pdf');
  });
});

describe('inputsHash', () => {
  const base: DocumentInputs = {
    company: 'Synechron',
    title: 'API Automation Tester',
    careerProfile: 'profile',
    coverLetter: 'letter',
    resumeVersion: 'test-analyst',
    resumeDocId: 'DOC',
    relocationNote: null,
    isInternational: false,
  };

  it('is stable for identical inputs and changes when anything that shapes the PDFs changes', () => {
    expect(inputsHash(base)).toBe(inputsHash({ ...base }));
    for (const change of [
      { careerProfile: 'new profile' },
      { coverLetter: 'new letter' },
      { resumeVersion: 'software-engineer' as const },
      { resumeDocId: 'OTHER' },
      { relocationNote: 'Open to relocation to NSW' },
      { isInternational: true },
    ]) {
      expect(inputsHash({ ...base, ...change })).not.toBe(inputsHash(base));
    }
  });
});


describe('newBatchName', () => {
  it('formats as YYYY-MM-DD-HH-MM-SS, matching the pre-refactor timestamp folders', () => {
    expect(newBatchName(new Date(2026, 8, 20, 6, 13, 7))).toBe('2026-09-20-06-13-07');
  });
});

describe('batchRootWindows', () => {
  it('appends the batch name to the configured Windows root', () => {
    expect(batchRootWindows('C:\\Users\\madhi\\OneDrive\\Documents\\Resumes Gen', '2026-09-20-06-13-07')).toBe(
      'C:\\Users\\madhi\\OneDrive\\Documents\\Resumes Gen\\2026-09-20-06-13-07',
    );
  });

  it('does not double up a trailing separator', () => {
    expect(batchRootWindows('C:\\x\\', 'b')).toBe('C:\\x\\b');
  });
});

describe('findActiveBatch', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the root does not exist or has no batch folders', async () => {
    dir = await mkdtemp(join(tmpdir(), 'docidx-'));
    expect(await findActiveBatch(join(dir, 'missing'))).toBeNull();
    expect(await findActiveBatch(dir)).toBeNull();
  });

  it('ignores a folder with no documents-index.json, e.g. an old timestamped layout folder', async () => {
    dir = await mkdtemp(join(tmpdir(), 'docidx-'));
    await mkdir(join(dir, '2026-09-18-23-06-01'), { recursive: true });
    await writeFile(join(dir, '2026-09-18-23-06-01', 'Anshu_Madhikarmi_Synechron_Resume.pdf'), 'x');
    expect(await findActiveBatch(dir)).toBeNull();
  });

  it('picks the batch folder whose index was written to most recently', async () => {
    dir = await mkdtemp(join(tmpdir(), 'docidx-'));
    await mkdir(join(dir, 'older'), { recursive: true });
    await writeFile(join(dir, 'older', INDEX_FILE), '{}');
    await new Promise((r) => setTimeout(r, 10));
    await mkdir(join(dir, 'newer'), { recursive: true });
    await writeFile(join(dir, 'newer', INDEX_FILE), '{}');
    expect(await findActiveBatch(dir)).toBe('newer');
  });
});
