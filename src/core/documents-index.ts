import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeCompany } from './dedupe.js';
import type { ResumeVersion } from './resume-version.js';

/**
 * Bookkeeping for the documents stage. Output layout is one fresh
 * timestamped batch folder per `generate-documents` run, holding one folder
 * per company inside it, each with that company's resume and cover-letter
 * PDFs for every currently-open role:
 *
 *   <root>/<batch>/Synechron/Anshu_Madhikarmi_Synechron_API_Automation_Tester_Resume.pdf
 *   <root>/<batch>/Synechron/Anshu_Madhikarmi_Synechron_API_Automation_Tester_Cover_Letter.pdf
 *   <root>/<batch>/documents-index.json
 *
 * Every run creates a brand-new batch rather than growing the last one
 * forever. Only jobs still selected for the 'documents' stage (still open:
 * not applied, closed, or given an interview-stage outcome) make it into
 * the new batch: one whose profile/letter/hash haven't changed since the
 * previous batch has its existing PDFs copied across instead of rebuilt
 * (cheap, no LibreOffice run needed); one that's new or changed is rebuilt
 * into the new batch; one that dropped out of selection (applied/closed)
 * is simply left behind in the previous batch, never copied forward. That
 * is what keeps the current batch from growing without bound — each run's
 * folder holds exactly what's still pending, nothing more.
 *
 * A batch folder is identified by holding its own documents-index.json —
 * that is what marks it as a batch this code produced, as opposed to an old
 * pre-refactor timestamped folder (flat PDFs, no index) sitting in the same
 * root, or one Anshu has manually moved into `_to_delete`. Among several,
 * the most-recently-written one is "active" — see findActiveBatch(), used
 * both as the migration source for the next `generate-documents` run and as
 * the read source for `export-apply-queue`. Old batches are never deleted
 * by this code; Anshu prunes them by hand whenever he likes.
 *
 * The index maps job id -> exactly which files were built for it, from
 * which inputs (a hash), so:
 *  - re-running generate-documents only rebuilds jobs whose inputs changed
 *    (or that have no files yet) instead of regenerating the whole batch;
 *  - the apply skills look files up by job id, never by fuzzy company match,
 *    which matters as soon as one company has more than one role in its folder.
 */

export const INDEX_FILE = 'documents-index.json';

/**
 * Bump when the resume/cover-letter layout logic in generate_documents.py
 * changes in a way existing PDFs should be rebuilt for. Part of the input
 * hash, so a bump regenerates everything once.
 */
export const GENERATOR_VERSION = 2;

export interface DocumentIndexEntry {
  company: string;
  title: string;
  /** Folder name, relative to the batch folder (not the output root). */
  folder: string;
  /** File names inside `folder`. */
  resume: string;
  coverLetter: string;
  resumeVersion: ResumeVersion;
  hash: string;
  generatedAt: string;
}

export interface DocumentsIndex {
  version: 1;
  /** The real Windows path to this batch folder, so skills running through the device bridge can build a browser-uploadable path. */
  rootWindows: string;
  updatedAt: string;
  jobs: Record<string, DocumentIndexEntry>;
}

const WINDOWS_ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_FOLDER_LENGTH = 60;

/** The company name as a Windows-safe folder title. Readable (spaces kept), not underscored like filenames. */
export function companyFolderName(company: string): string {
  const trimEnds = (s: string) => s.trim().replace(/[. ]+$/, '');
  let name = trimEnds(company.replace(WINDOWS_ILLEGAL, '').replace(/\s+/g, ' '));
  name = trimEnds(name.slice(0, MAX_FOLDER_LENGTH));
  if (!name) return 'Unknown company';
  return WINDOWS_RESERVED.test(name) ? `${name} Co` : name;
}

/** Identity of a company for "does its folder already exist": the scraper's own normaliser ("Atlassian Pty Ltd" == "Atlassian"). */
export function companyKey(company: string): string {
  return normalizeCompany(company) || company.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * The folder this company's documents go into: an existing folder for the
 * same company if there is one (case-insensitive, legal-suffix-insensitive),
 * otherwise the new folder name. Never creates anything itself.
 */
export function resolveCompanyFolder(existingFolders: string[], company: string): string {
  const key = companyKey(company);
  const wanted = companyFolderName(company);
  const exact = existingFolders.find((f) => f.toLowerCase() === wanted.toLowerCase());
  if (exact) return exact;
  const sameCompany = [...existingFolders].sort().find((f) => companyKey(f) === key);
  return sameCompany ?? wanted;
}

/**
 * File names for one job inside its company folder. Same role at the same
 * company twice (two postings, or two locations) would collide on the plain
 * name, so a short job-id suffix goes in only when another job already owns
 * that exact name.
 */
export function pickFileNames(
  index: DocumentsIndex,
  jobId: string,
  folder: string,
  resumeName: string,
  coverLetterName: string,
): { resume: string; coverLetter: string } {
  const takenByOther = Object.entries(index.jobs).some(
    ([id, e]) => id !== jobId && e.folder.toLowerCase() === folder.toLowerCase() && e.resume.toLowerCase() === resumeName.toLowerCase(),
  );
  if (!takenByOther) return { resume: resumeName, coverLetter: coverLetterName };
  const suffix = `_${jobId.slice(0, 6)}`;
  const withSuffix = (n: string) => n.replace(/(_Resume|_Cover_Letter)\.pdf$/i, `${suffix}$1.pdf`);
  return { resume: withSuffix(resumeName), coverLetter: withSuffix(coverLetterName) };
}

export interface DocumentInputs {
  company: string;
  title: string;
  careerProfile: string;
  coverLetter: string;
  resumeVersion: ResumeVersion;
  resumeDocId: string;
  relocationNote: string | null;
  isInternational: boolean;
}

/** Everything that changes what the PDFs contain. Base-doc edits in Google Docs are not visible here: use --force for those. */
export function inputsHash(inputs: DocumentInputs): string {
  return createHash('sha1')
    .update(JSON.stringify({ g: GENERATOR_VERSION, ...inputs }))
    .digest('hex');
}

export function emptyIndex(rootWindows: string): DocumentsIndex {
  return { version: 1, rootWindows, updatedAt: new Date().toISOString(), jobs: {} };
}

export async function readIndex(root: string, rootWindows: string): Promise<DocumentsIndex> {
  try {
    const parsed = JSON.parse(await readFile(join(root, INDEX_FILE), 'utf8')) as DocumentsIndex;
    if (parsed.version === 1 && parsed.jobs) return { ...parsed, rootWindows };
  } catch {
    /* no index yet, or unreadable: start fresh, every job will be (re)generated once */
  }
  return emptyIndex(rootWindows);
}

export async function writeIndex(root: string, index: DocumentsIndex): Promise<void> {
  await mkdir(root, { recursive: true });
  index.updatedAt = new Date().toISOString();
  await writeFile(join(root, INDEX_FILE), JSON.stringify(index, null, 2), 'utf8');
}

/* ------------------------------------------------------------- batch dir */

/** `YYYY-MM-DD-HH-MM-SS`, matching the naming already used by the pre-refactor timestamped output folders. */
export function newBatchName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-` +
    `${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`
  );
}

/**
 * The most recent batch folder generate-documents produced, directly under
 * `outRoot` — used both as the migration source for a new generate-documents
 * run and as the read source for export-apply-queue. A folder counts as a
 * live batch only once it holds its own documents-index.json — that is what
 * distinguishes it from the pre-refactor timestamped folders already
 * sitting in the same root (flat PDFs, or an AU/International split, never
 * an index file) and from anything Anshu has moved elsewhere by hand.
 * Among several live batches, the one whose index was written to most
 * recently is "active". Returns null when there is no live batch yet.
 */
export async function findActiveBatch(outRoot: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(outRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates: Array<{ name: string; mtimeMs: number }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const st = await stat(join(outRoot, e.name, INDEX_FILE));
      candidates.push({ name: e.name, mtimeMs: st.mtimeMs });
    } catch {
      /* no documents-index.json in this folder: not a batch */
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].name;
}

/** `outRoot`'s Windows path with `batch` appended, for `DocumentsIndex.rootWindows`. */
export function batchRootWindows(outRootWindows: string, batch: string): string {
  return `${outRootWindows.replace(/[\\/]+$/, '')}\\${batch}`;
}
