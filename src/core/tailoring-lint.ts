import { normalizeCompany } from './dedupe.js';

/**
 * Deterministic checks on LLM-written career profiles and cover letters,
 * run by the apply commands BEFORE anything is written to jobs.json. These
 * are the rules the prompts already state ("never use an em dash", "250-350
 * words", "no placeholder brackets", "mention the company") turned into code,
 * so a slip is caught for free at write-back instead of being noticed on a
 * finished PDF. A failing entry is rejected with its reasons and the job
 * stays in the inbox for the next attempt.
 *
 * Deliberately rules a regex can decide. Anything needing judgment (tone,
 * whether a claim is supported by the resume) stays with the prompt.
 */

/** Em dash, horizontal bar, or a spaced en dash used as a dash. Bare en dashes in ranges (2019-2021) are fine. */
const DASH = /—|―|\s–\s/;
const PLACEHOLDER = /\[[^\]\n]{2,}\]/;
const LIST_LINE = /^\s*(?:[-*•▪◦]|\d+[.)])\s+\S/m;
const MARKDOWN = /\*\*|^#{1,6}\s/m;
const JSON_LEAK = /"career_profile"|"cover_letter"|^\s*[{[]/;

const PROFILE_WORDS = { min: 60, max: 170 };
/** The prompt asks for 250-350; a little slack either side because counters disagree on hyphenated words. */
const LETTER_WORDS = { min: 235, max: 365 };
const LETTER_PARAGRAPHS = { min: 3, max: 7 };

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** First significant token of the company, as the text would naturally name it ("Synechron", "Southern"). */
function companyToken(company: string): string {
  const token = normalizeCompany(company).split(' ').find((t) => t.length >= 3);
  return token ?? company.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function mentionsCompany(text: string, company: string): boolean {
  const token = companyToken(company);
  return token.length > 0 && text.toLowerCase().includes(token);
}

function commonIssues(text: string, company: string, issues: string[]): void {
  if (DASH.test(text)) issues.push('contains an em dash (or a spaced en dash used as one)');
  if (PLACEHOLDER.test(text)) issues.push('contains a [placeholder] bracket');
  if (MARKDOWN.test(text)) issues.push('contains markdown (bold or headers)');
  if (JSON_LEAK.test(text)) issues.push('looks like raw JSON leaked into the text');
  if (!mentionsCompany(text, company)) issues.push(`never mentions the company ("${company}")`);
}

export function lintCareerProfile(text: string, company: string): string[] {
  const issues: string[] = [];
  if (!text.trim()) return ['is empty'];
  if (/\n/.test(text.trim())) issues.push('is not a single paragraph (contains a line break)');
  if (LIST_LINE.test(text)) issues.push('contains bullets or a numbered list');
  const words = wordCount(text);
  if (words < PROFILE_WORDS.min || words > PROFILE_WORDS.max) {
    issues.push(`is ${words} words, expected ${PROFILE_WORDS.min}-${PROFILE_WORDS.max} for a one-paragraph profile`);
  }
  commonIssues(text, company, issues);
  return issues;
}

export function lintCoverLetter(text: string, company: string): string[] {
  const issues: string[] = [];
  if (!text.trim()) return ['is empty'];
  const body = text.trim();
  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim());
  if (paragraphs.length < LETTER_PARAGRAPHS.min || paragraphs.length > LETTER_PARAGRAPHS.max) {
    issues.push(`has ${paragraphs.length} paragraph(s), expected ${LETTER_PARAGRAPHS.min}-${LETTER_PARAGRAPHS.max} separated by blank lines`);
  }
  if (LIST_LINE.test(body)) issues.push('contains bullets or a numbered list');
  const words = wordCount(body);
  if (words < LETTER_WORDS.min || words > LETTER_WORDS.max) {
    issues.push(`is ${words} words, expected about 250-350`);
  }
  // generate_documents.py adds the salutation and sign-off itself.
  if (/^dear\b/i.test(body)) issues.push('starts with a salutation (the document builder adds "Dear <company> Hiring Team")');
  if (/(?:regards|sincerely|yours|thanks|thank you|cheers),?\s*(?:anshu(?: madhikarmi)?)?\s*$/i.test(body) || /anshu madhikarmi\s*$/i.test(body)) {
    issues.push('ends with a sign-off or name (the document builder adds it)');
  }
  if (/^i am writing to (?:express|apply)/i.test(body)) issues.push('opens with the generic "I am writing to express my interest"');
  commonIssues(body, company, issues);
  return issues;
}
