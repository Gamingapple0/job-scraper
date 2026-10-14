import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApplicationSchema, sentences, type Application, type CorpusDoc } from './application.js';
import type { Ledger } from './ledger.js';
import type { Job } from './types.js';
import { formatLocation } from './export.js';
import { buildCoverLetterFileName, buildResumeFileName, sanitizeFilenamePart, titleClause } from './stage-export.js';

/** Where application folders live: applications/<date>-<company>-<role>/ */
export const APPLICATIONS_DIR = 'applications';

export interface AppFolder {
  dir: string;
  app: Application;
  letter?: string;
  jd: string;
}

export function readAppFolder(dir: string): AppFolder {
  const raw = JSON.parse(readFileSync(join(dir, 'application.json'), 'utf8'));
  const app = ApplicationSchema.parse(raw);
  const letterPath = join(dir, 'letter.txt');
  const letter = existsSync(letterPath) ? readFileSync(letterPath, 'utf8').trim() || undefined : undefined;
  const jdPath = join(dir, 'jd.txt');
  const jd = existsSync(jdPath) ? readFileSync(jdPath, 'utf8') : '';
  return { dir, app, letter, jd };
}

export function appSlug(job: Pick<Job, 'company' | 'title'>, date = new Date()): string {
  return [date.toISOString().slice(0, 10), sanitizeFilenamePart(job.company), sanitizeFilenamePart(titleClause(job.title))].join('-').slice(0, 90);
}

/**
 * Everything already written for earlier applications: other v2 folders, and
 * every career profile / cover letter the old pipeline produced. A new
 * document may not reuse a sentence or a summary opener from any of them.
 */
export function buildCorpus(exceptDir: string, jobs: Job[], root = APPLICATIONS_DIR): CorpusDoc[] {
  const docs: CorpusDoc[] = [];
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      if (dir === exceptDir || join(dir) === join(exceptDir) || !existsSync(join(dir, 'application.json'))) continue;
      try {
        const { app, letter } = readAppFolder(dir);
        const bullets = [...app.employment, ...app.projects].flatMap((s) => s.bullets.map((b) => b.text));
        const prose = [...sentences(app.summary), ...(letter ? sentences(letter) : [])];
        docs.push({ source: dir, opener: app.summary, sentences: [...prose, ...bullets], prose });
      } catch {
        // a half-written draft folder is not corpus yet
      }
    }
  }
  for (const j of jobs) {
    const prose = [...sentences(j.careerProfile ?? ''), ...sentences(j.coverLetter ?? '')];
    if (prose.length === 0) continue;
    docs.push({ source: `old pipeline: ${j.title} at ${j.company}`, opener: j.careerProfile, sentences: prose, prose });
  }
  return docs;
}

export function jdText(job: Job): string {
  return [
    `${job.title}`,
    `${job.company} | ${formatLocation(job)}${job.postedAt ? ` | posted ${job.postedAt.slice(0, 10)}` : ''}`,
    job.url,
    '',
    job.description ?? '(no description scraped: paste the full JD here before writing anything)',
  ].join('\n');
}

const fmtDates = (start: string | undefined, end: string) => (start ? `${start} - ${end}` : end); // MM/YYYY, as on the resumes that parsed
/** Bullets never end with a full stop, so punctuation is consistent down the page. */
/** Last two words joined by a no-break space so a line never ends with one orphan word (Word's widow control for a line). */
const keepLastTwo = (t: string) => t.replace(/ (\S+)$/, '\u00a0$1');
const noStop = (b: { label: string; text: string }) => ({ ...b, text: keepLastTwo(b.text.trim().replace(/\.$/, '')) });

/** application.json + ledger -> the flat document render_application.py lays out. Titles, employers and dates only ever come from the ledger. */
export function toRenderDoc(f: AppFolder, ledger: Ledger, outDir: string) {
  const { app, letter } = f;
  const c = ledger.contact;
  const roleOf = (ref: string) => ledger.roles.find((r) => r.id === ref)!;
  const order = ledger.roles.map((r) => r.id);
  const employment = [...app.employment]
    .sort((a, b) => order.indexOf(a.ref) - order.indexOf(b.ref))
    .map((s) => {
      const r = roleOf(s.ref);
      return { ref: r.id, title: r.title, company: r.company, dates: fmtDates(r.start, r.end), bullets: s.bullets.map(noStop) };
    });
  const projects = app.projects.map((s) => {
    const p = ledger.projects.find((x) => x.id === s.ref)!;
    return { name: p.name, stack: p.stack.join(', '), bullets: s.bullets.map(noStop) };
  });
  const marks = app.education.marks
    .map((code) => ledger.transcript.find((t) => t.code === code)!)
    .map((t) => `${t.code} ${t.name} (${t.mark})`);
  // Diploma dropped from the page (still a ledger fact).
  const education = ledger.education.filter((e) => e.id === 'bcs').map((e, i) => ({
    degree: e.degree_note ? `${e.degree} (${e.degree_note})` : e.degree,
    school: e.school,
    dates: fmtDates(e.start, e.end),
    details: [e.display, ...(i === 0 && marks.length ? [`Selected units: ${marks.join(', ')}`] : [])],
  }));
  const stemOf = (name: string) => name.replace(/\.docx$/i, '');
  return {
    header: { name: c.name, headline: app.headline, contact: [c.location, app.international ? c.phone_intl : c.phone, c.email, c.linkedin, c.website] },
    summary: keepLastTwo(app.summary.trim()),
    employment,
    projects,
    education,
    skills: app.skills,
    letter: letter ? { company: app.company, paragraphs: letter.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean) } : undefined,
    out: {
      dir: outDir,
      resume: stemOf(buildResumeFileName(app.role, app.company)),
      letter: stemOf(buildCoverLetterFileName(app.role, app.company)),
    },
  };
}
