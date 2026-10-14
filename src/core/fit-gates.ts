import type { Job } from './types.js';

/**
 * Framework v2 hard gates (section 5, "Drop entirely"): rules literal enough
 * for code, applied before any fit-filter judging so a gated job never costs
 * a token and can't slip through on an agent's off day. Returns the reason,
 * or null when the job goes on to the fit filter. Everything that needs
 * judgment (seniority from the body, must-have coverage, tiering, the
 * sponsorship route for global roles) stays with the fit-filter prompt.
 */

/** Citizenship, PR or clearance, in any country. The `citizen-only` scrape tag is honoured too. */
const CITIZEN =
  /must be (?:an? )?(?:australian |new zealand |nz |uk |us |singaporean )?citizen|citizens? only|citizenship (?:is )?(?:required|essential|mandatory)|(?:must|need to|required to) (?:be|hold) (?:an? )?(?:australian )?(?:citizen|permanent resident)|permanent residen(?:t|ts|cy) (?:only|required|is required|status required)|(?:security|baseline|government) clearance|\bnv[12]\b|\bagsva\b|\bsc clearance\b|must (?:hold|have|obtain|be eligible for) (?:an? |the )?(?:\w+ )?clearance/i;

const BLOCKED_COMPANIES = [
  // body shops
  'infosys', 'accenture', 'tata consultancy', 'tcs', 'cognizant', 'wipro', 'capgemini', 'synechron',
  // aggregator reposts and AI-training gigs
  'jobgether', 'jobright', 'crossing hurdles', 'careeraiforge', 'alignerr', 'the ai training company',
  // Anshu's own blacklist
  'lyra', 'leap legal',
];

const SENIOR_TITLE = /\b(?:senior|snr|sr\.?|lead|principal|staff|architect|manager|head of|director|vice president|vp|avp|iii|iv)\b|\b(?:engineer|developer|se)\s*[3-9]\b|\blevel\s*[3-9]\b/i;

const DROPPED_FAMILY =
  /\b(?:devops|sre|site reliability|security|cyber\w*|ios|android|mobile|react native|flutter|data (?:engineer|scientist|analyst)|machine learning|ml engineer|forward[- ]deployed|founding|manual test\w*|annotat\w*|ai trainer|ai training)\b/i;

const NON_ENGLISH_TITLE = /\b(?:entwickler\w*|ontwikkelaar|werkstudent|m\/w\/d|w\/m\/d|d\/f\/m|ingénieur|développeur)\b/i;
const FOREIGN_STOPWORDS = /\b(?:und|der|die|das|wir|für|mit|het|een|voor|wij|zijn|bij|nous|vous|avec)\b/gi;

export function hardGate(job: Pick<Job, 'title' | 'company' | 'description' | 'tags'>): string | null {
  const body = job.description ?? '';
  const cit = body.match(CITIZEN) ?? job.title.match(CITIZEN);
  if (cit) return `gate: requires citizenship, PR or clearance ("${cit[0]}")`;
  if (job.tags.includes('citizen-only')) return 'gate: tagged citizen-only at scrape time';

  const company = job.company.toLowerCase();
  const blocked = BLOCKED_COMPANIES.find((b) => new RegExp(`(?:^|\\W)${b}(?:\\W|$)`).test(company));
  if (blocked) return `gate: ${job.company} is on the drop list (body shop, aggregator or blacklist)`;

  const senior = job.title.match(SENIOR_TITLE);
  if (senior) return `gate: title is above the junior band ("${senior[0]}")`;
  const family = job.title.match(DROPPED_FAMILY);
  if (family) return `gate: role family dropped in v2 ("${family[0]}")`;

  if (NON_ENGLISH_TITLE.test(job.title)) return 'gate: non-English posting';
  const words = body.split(/\s+/).length;
  const foreign = (body.match(FOREIGN_STOPWORDS) ?? []).length;
  if (foreign >= 15 && foreign / Math.max(words, 1) > 0.03) return 'gate: non-English posting';
  return null;
}
