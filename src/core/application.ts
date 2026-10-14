import { z } from 'zod';
import { letterFacts, resumeFacts, skillIndex, type Ledger } from './ledger.js';
import { mentionsTitle, titleCandidates } from './tailoring-lint.js';

/**
 * Framework v2: one hand-built application per job, as structured data
 * (applications/<slug>/application.json + optional letter.txt + jd.txt).
 * Dates, titles and employers come from the ledger by `ref`, so the author
 * only writes the summary, bullet labels/text, skill rows and the letter.
 * checkApplication() is the deterministic QA gate (framework section 9,
 * items 1, 4 (resume checklist), 6 and 7). Judgment checks (thesis, EM scan,
 * recruiter diagnosis, humanscope on the letter) stay with the workflow doc.
 */

const Bullet = z.object({ label: z.string().default(""), text: z.string().min(1) });
const Section = z.object({ ref: z.string(), bullets: z.array(Bullet) });

export const ARCHETYPES = ['backend-db', 'fullstack-java-react', 'quality-sdet', 'consultancy-ai', 'graduate'] as const;

export const ApplicationSchema = z.object({
  jobId: z.string().optional(),
  company: z.string().min(1),
  role: z.string().min(1),
  url: z.string().optional(),
  tier: z.enum(['A', 'B']),
  family: z.enum(['A', 'B', 'C', 'D']),
  archetype: z.enum(ARCHETYPES),
  thesis: z.string().min(10),
  international: z.boolean().default(false),
  /** Name-line headline: the posting's title, plus relocation note / PTE where app-new added them. */
  headline: z.string().min(1),
  summary: z.string().min(1),
  employment: z.array(Section),
  projects: z.array(Section).default([]),
  education: z.object({ marks: z.array(z.string()).max(3).default([]) }).default({ marks: [] }),
  skills: z.array(z.object({ label: z.string().min(1), items: z.array(z.string()).min(1) })),
  status: z.enum(['draft', 'ready', 'sent']).default('draft'),
  sentAt: z.string().optional(),
});

export type Application = z.infer<typeof ApplicationSchema>;

export interface CheckInput {
  app: Application;
  letter?: string;
  jd: string;
  ledger: Ledger;
  /** Sentences from every other application and every earlier pipeline document. */
  corpus: CorpusDoc[];
  /** Headline parts the job's location demands ("Open to relocation to ACT", "PTE: 88"). */
  requiredHeadline?: string[];
}

export interface CorpusDoc {
  source: string;
  /** First sentence of a summary/profile, for the opener rule. */
  opener?: string;
  sentences: string[];
  /** Summary and letter sentences get the stricter near-duplicate test. */
  prose: string[];
}

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

/* ------------------------------------------------------------- text helpers */

const NUMBER_WORDS: Record<string, string> = {
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', twenty: '20', thirty: '30', fifty: '50', hundred: '100', thousand: '1000',
};

const STOP = new Set(
  'the and for with from into that this then than was were are has have had its his her our your their which while when where across over under per via onto each both also only more most less fewer about after before every within without between against through'.split(' '),
);

/** Digit strings in text, commas dropped, words two..thousand mapped to digits. "SIT331"/"Vue3" are names, not numbers. */
export function numbersIn(text: string): string[] {
  const out = (text.match(/(?<![A-Za-z#.\d])\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));
  for (const w of text.toLowerCase().match(/\b[a-z]+\b/g) ?? []) if (NUMBER_WORDS[w]) out.push(NUMBER_WORDS[w]);
  return out;
}

export function contentWords(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z+#.-]{2,}/g) ?? [])
      .map((w) => w.replace(/[.-]+$/, '').replace(/(?<=..)(?:ing|ed|es|s)$/, ''))
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normalizeSentence(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function trigrams(s: string): Set<string> {
  const w = normalizeSentence(s).split(' ');
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

export function similarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

const wordCount = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Word-ish boundary that also works for "C#", ".NET", "Node.js", "CI/CD". */
export const termRe = (t: string, flags = 'i') => new RegExp(`(?<![\\w#+.])${esc(t)}(?![\\w#+])`, flags);

/* ----------------------------------------------------------------- rule sets */

/** Technologies the validator recognises. A match not backed by the ledger is a claim the ledger can't support. */
export const TECH_TERMS = [
  // ledger-backed (listed so membership is checked, not assumed)
  'Java', 'JavaScript', 'TypeScript', 'Python', 'Kotlin', 'C#', '.NET', 'SQL', 'PostgreSQL', 'React', 'Next.js', 'Vue',
  'Node.js', 'Spring Boot', 'Spring Security', 'GraphQL', 'REST', 'Playwright', 'WebdriverIO', 'JUnit', 'Vitest', 'JMeter',
  'TestRail', 'Jenkins', 'Bamboo', 'Splunk', 'Jira', 'Confluence', 'Git', 'Docker', 'Kubernetes', 'AWS', 'Terraform',
  'Android', 'Django', 'DigitalOcean', 'Claude Code', 'MCP', 'Flower', 'ResNet', 'Google Sheets API',
  // not in the ledger
  'Golang', 'Rust', 'Scala', 'Ruby', 'Rails', 'PHP', 'Laravel', 'C++', 'Swift', 'Objective-C', 'Flutter', 'Dart',
  'React Native', 'Angular', 'Svelte', 'Redux', 'Express', 'NestJS', 'Flask', 'FastAPI', 'Hibernate', 'Maven', 'Gradle',
  'Spring Cloud', 'Kafka', 'RabbitMQ', 'Redis', 'MongoDB', 'MySQL', 'SQL Server', 'Oracle', 'DynamoDB', 'Cassandra',
  'Elasticsearch', 'Snowflake', 'Spark', 'Airflow', 'dbt', 'Hadoop', 'Azure', 'GCP', 'Google Cloud', 'Lambda', 'EC2',
  'S3', 'ECS', 'EKS', 'RDS', 'CloudFormation', 'Ansible', 'Helm', 'ArgoCD', 'GitHub Actions', 'GitLab', 'CircleCI',
  'Datadog', 'Grafana', 'Prometheus', 'New Relic', 'Selenium', 'Cypress', 'Jest', 'Mocha', 'Cucumber', 'Appium',
  'Postman', 'Rest Assured', 'k6', 'LoadRunner', 'Gatling', 'Salesforce', 'SAP', 'ServiceNow', 'Tableau', 'Power BI',
  'TensorFlow', 'PyTorch', 'LangChain', 'OpenAI', 'Microservices', 'gRPC', 'Kinesis', 'SQS', 'Linux',
  'Keycloak', 'JWT', 'OAuth', 'Firebase', 'Firestore', 'Nuxt', 'Karate', 'Temporal',
];

const BANNED_WORDS: Array<[RegExp, string]> = [
  [/\bspearhead\w*/i, 'spearheaded'],
  [/\bleverag\w*/i, 'leveraged'],
  [/\borchestrat\w*/i, 'orchestrated'],
  [/\bdrove\b/i, 'drove'],
  // Weak verbs CV scorers flag ("Worked", "assisted in", "helped").
  [/\bworked (?:on|with|through|in|across)\b|^worked\b/i, 'weak verb "worked"'],
  // CareerSet substring-matches "work in", so "work includes" is flagged too.
  [/\bwork in/i, 'weak verb "work in" (CareerSet flags it, even inside "work includes")'],
  [/(?<!-)\bassisted\b|\bhelped\b|\bparticipated in\b|\binvolved in\b|\bresponsible for\b|\btasked with\b/i, 'weak verb (assisted/helped/participated/responsible for)'],
  [/\bchampion\w*/i, 'championed'],
  [/\brobust\w*/i, 'robust'],
  [/\bseamless\w*/i, 'seamless'],
  [/\bcutting[- ]edge\b/i, 'cutting-edge'],
  [/\bdynamic\b/i, 'dynamic'],
  [/\bpassion\w*/i, 'passionate'],
  [/\bsynerg\w*/i, 'synergy'],
  [/\bproven track record\b/i, 'proven track record'],
  [/\bresults[- ]driven\b/i, 'results-driven'],
  [/\bdetail[- ]oriented\b/i, 'detail-oriented'],
  [/\bnot (?:just|only)\b[^.]{0,80}\bbut\b/i, '"not just X, but Y"'],
  [/—|―|\s–\s/, 'em dash'],
  [/\bwell[- ]matched to\b/i, '"well matched to"'],
  [/\bstrong match for\b/i, '"strong match for"'],
  [/\[[^\]\n]{2,}\]/, '[placeholder]'],
  [/\*\*|^#{1,6}\s/m, 'markdown'],
];

/** Gap confessions and generic openers (letter rules, section 8). Checked on letters and summaries. */
const GAP_PHRASES: Array<[RegExp, string]> = [
  [/\balthough\b/i, '"although"'],
  [/\brather than\b/i, '"rather than"'],
  [/\beven though\b/i, '"even though"'],
  [/\bexposure from university and personal projects\b/i, '"exposure from university and personal projects"'],
  [/\bwould be a first for me\b/i, '"would be a first for me"'],
  [/\bi am writing to\b/i, '"I am writing to"'],
  [/\bi am excited to apply\b/i, '"I am excited to apply"'],
  [/\b(?:while|though) i (?:have not|haven't|lack|don't)\b/i, 'gap confession'],
];

/** Claims the ledger forbids outright. */
const FORBIDDEN_CLAIMS: Array<[RegExp, string]> = [
  [/\bpermanent residen\w*/i, 'claims permanent residency'],
  [/\bcitizen\w*/i, 'mentions citizenship'],
  [/\bjan(?:uary)?\.? 2025\b/i, '"Jan 2025" start date (JDR SWE started 07/2025)'],
  [/\b(?:\d+|one|two|three|four|five|six|several|many)\+?\s*(?:years?|yrs?)\b(?!\s+ago)/i, 'years-of-experience claim (not in the ledger)'],
  [/\bsenior\b/i, '"senior"'],
];

const BENEFIT_TAIL = /,\s*(?:ensuring|improving|enabling|resulting in|leading to|driving|delivering|boosting|increasing|reducing|allowing|making|keeping|helping|supporting)\b[^,.]*\.?\s*$/i;

const RHYTHM_ADJ = new Set(
  'fast reliable scalable robust secure maintainable efficient clean modern intuitive performant accessible resilient stable consistent responsive testable readable'.split(' '),
);

/** Project bullets must read as a data-engineering project, never as an application machine (section 4). */
const PROJECT_FORBIDDEN = /\b(?:resumes?|cover letters?|tailor\w*|prompts?|auto-?appl\w*|apply queue|claude|llm|gpt|chatgpt|easy apply|quick apply|apply agent|generated documents?)\b/i;

/* --------------------------------------------------------------------- check */

export function checkApplication(input: CheckInput): CheckResult {
  const { app, ledger, jd, corpus } = input;
  const letter = input.letter?.trim() || undefined;
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (where: string, msg: string) => errors.push(`${where}: ${msg}`);

  /* ---- structure ---- */
  const roleIds = ledger.roles.map((r) => r.id);
  const seen = new Set<string>();
  for (const s of app.employment) {
    const role = ledger.roles.find((r) => r.id === s.ref);
    if (!role) {
      err('employment', `unknown ref "${s.ref}" (ledger roles: ${roleIds.join(', ')})`);
      continue;
    }
    if (seen.has(s.ref)) err('employment', `"${s.ref}" appears twice`);
    seen.add(s.ref);
    const { min, max } = bulletRange(app.archetype, s.ref, role.bullets);
    if (s.bullets.length < min || s.bullets.length > max) {
      err(s.ref, `${s.bullets.length} bullets, spec is ${min}-${max}${app.archetype === 'quality-sdet' ? ' (QA archetype)' : ''}`);
    }
  }
  for (const id of roleIds) if (!seen.has(id)) err('employment', `role "${id}" is missing (every ledger role stays on the page)`);

  for (const s of app.projects) {
    const p = ledger.projects.find((x) => x.id === s.ref);
    if (!p) err('projects', `unknown ref "${s.ref}"`);
    else if (s.bullets.length < p.bullets.min || s.bullets.length > p.bullets.max) {
      err(s.ref, `${s.bullets.length} bullets, spec is ${p.bullets.min}-${p.bullets.max}`);
    }
    for (const b of s.bullets) if (PROJECT_FORBIDDEN.test(`${b.label} ${b.text}`)) err(s.ref, `"${b.label}" mentions the application tooling; the project is framed strictly as data engineering`);
  }

  for (const code of app.education.marks) {
    if (!ledger.transcript.some((t) => t.code === code)) err('education', `transcript unit "${code}" not in the ledger`);
  }

  /* ---- headline ---- */
  if (!mentionsTitle(app.headline, app.role)) err('headline', `must carry the posting's title ("${titleCandidates(app.role)[0]}")`);
  if (/—|―|\s–\s/.test(app.headline)) err('headline', 'em dash');
  for (const part of input.requiredHeadline ?? []) if (!app.headline.includes(part)) err('headline', `must include "${part}" (relocation rule: keep it even when the ad also allows Melbourne)`);

  /* ---- summary ---- */
  const sw = wordCount(app.summary);
  // The Xero summary that won an interview ran 112 words: dense, role-specific, 6-7 lines.
  if (sw < 90 || sw > 125) err('summary', `${sw} words, spec is 90-125 (the Xero summary was 112)`);
  if (/^\s*full[- ]stack software engineer with\b/i.test(app.summary)) err('summary', 'opens "Full Stack Software Engineer with..." (banned opener)');
  // Xero style: the summary characterises fit in the JD's terms; the bullets carry the metrics.
  const summaryNums = new Set(numbersIn(app.summary.replace(/\bN\+1\b/gi, ''))).size;
  if (summaryNums > 2) err('summary', `${summaryNums} numbers; keep metrics for the bullets (2 at most here)`);
  const companyRe = termRe(companyName(app.company), 'gi');
  const summaryCompany = (app.summary.match(companyRe) ?? []).length;
  if (summaryCompany < 1 || summaryCompany > 2) err('summary', `names ${app.company} ${summaryCompany} times; name the company (and its team) once or twice`);

  /* ---- bullets ---- */
  const bullets = [...app.employment, ...app.projects].flatMap((s) => s.bullets.map((b) => ({ ref: s.ref, ...b })));
  for (const b of bullets) {
    const where = `${b.ref} "${b.label}"`;
    const lw = wordCount(b.label);
    if (lw > 6) err(where, `label is ${lw} words; keep lead-in labels short`);
    if (b.text.includes(':')) err(where, 'colon inside bullet text (colons belong only to the label)');
    if (BENEFIT_TAIL.test(b.text)) err(where, 'ends on a trailing benefit clause (", ensuring...", ", improving...")');
    if (/\bfreelanc\w*/i.test(b.text)) err(where, 'freelance work never appears on the resume');
  }
  // CV scorers: personal pronouns, one sentence per bullet, no lead verb used more than twice.
  const PRONOUN = /\b(?:I|I'm|I've|me|my|mine|we|our|us|it|its|it's|they|them|their)\b/i;
  for (const b of bullets) {
    const where = `${b.ref} "${b.label}"`;
    const p = b.text.match(PRONOUN);
    if (p) err(where, `personal pronoun "${p[0]}"; name the thing instead`);
    if (/[.;!?]\s+\S/.test(b.text.trim())) err(where, 'more than one sentence; one sentence per bullet (scorers read the second as inconsistent punctuation)');
  }
  const leads = new Map<string, number>();
  for (const b of bullets) {
    const v = (b.text.trim().split(/\s+/)[0] ?? '').toLowerCase();
    leads.set(v, (leads.get(v) ?? 0) + 1);
  }
  for (const [v, n] of leads) if (n > 2) err('bullets', `"${v}" leads ${n} bullets; use it at most twice`);
  // CareerSet counts every use of an action verb across the whole CV (summary + bullets, any tense):
  // "Owns" in the summary + "Own" + "Owned" in bullets = 3 and is flagged.
  const cvText = [app.summary, ...bullets.map((b) => b.text)].join(' ');
  if (/\d,\d{3}/.test(cvText)) err('cv', 'thousands comma in the resume; write 2000+, not 2,000+ (CareerSet date issue suspect, 8 Oct)');
  for (const [v, n] of actionVerbCounts(cvText)) if (n > 2) err('cv', `action verb "${v}" used ${n} times across summary and bullets (any tense); CareerSet allows 2`);
  // CareerSet (8 Oct, Date tests P3/T1/T2): every reworded Bamboo/regression bullet broke date parsing, with or
  // without the number. Only the template's own wording passes, so the QA Bamboo bullet is used verbatim.
  for (const b of bullets) {
    if (b.ref === 'jdr-qa' && /\bbamboo\b/i.test(b.text) && b.text.replace(/\.\s*$/, '') !== QA_BAMBOO_BULLET) {
      err(`jdr-qa "${b.label}"`, `Bamboo bullet must be the template wording verbatim (rewordings broke CareerSet dates): "${QA_BAMBOO_BULLET}"`);
    }
  }
  const sp = app.summary.match(PRONOUN);
  if (sp) err('summary', `personal pronoun "${sp[0]}"`);

  if (bullets.length >= 4) {
    const lens = bullets.map((b) => wordCount(b.text));
    if (!lens.some((n) => n <= 18)) err('bullets', 'no short (one-line) bullet; mix lengths');
    if (!lens.some((n) => n >= 24)) err('bullets', 'no long (two-line) bullet; mix lengths');
    if (bullets.every((b) => numbersIn(b.text).length > 0)) err('bullets', 'every bullet carries a number; not every bullet needs one');
  }

  /* ---- skills ---- */
  const idx = skillIndex(ledger);
  const rows = app.skills;
  if (rows.length < 3 || rows.length > 5) err('skills', `${rows.length} rows, spec is 3-5 labelled rows (rendered as two lines)`);
  rows.forEach((row, i) => {
    const isExposure = /^additional exposure$/i.test(row.label.trim());
    if (isExposure && i !== rows.length - 1) err('skills', '"Additional exposure" must be the last row');
    for (const item of row.items) {
      const s = idx.get(item.trim().toLowerCase());
      if (!s) {
        err('skills', `"${item}" is not a ledger skill (add it to facts.yaml only once Anshu confirms it)`);
        continue;
      }
      if (isExposure) continue;
      if (s.placement === 'exposure') err('skills', `"${item}" is rated 2 or less: "Additional exposure" row only`);
      if (s.placement === 'jd' && !mentionsSkill(jd, s.name, ledger)) err('skills', `"${item}" goes in a core row only when the JD asks for it, and this JD doesn't`);
    }
  });

  /* ---- text-wide rules ---- */
  const resumeParts: Array<[string, string]> = [
    ['summary', app.summary],
    ...bullets.map((b): [string, string] => [`${b.ref} "${b.label}"`, `${b.label} ${b.text}`]),
    ...rows.map((r): [string, string] => ['skills label', r.label]),
  ];
  const resumeFactLines = resumeFacts(ledger);
  for (const [where, text] of resumeParts) {
    textRules(where, text, errors);
    numberRule(where, text, resumeFactLines, errors);
    toolRule(where, text, ledger, jd, where === 'summary', errors, warnings);
  }
  for (const [where, text] of [['summary', app.summary] as const]) {
    for (const [re, name] of GAP_PHRASES) if (re.test(text)) err(where, `${name}`);
  }
  rhythmRule('resume', [app.summary, ...bullets.map((b) => b.text)].join(' '), errors);

  /* ---- letter ---- */
  if (letter) {
    const lw = wordCount(letter);
    if (lw < 180 || lw > 260) err('letter', `${lw} words, spec is 180-260`);
    const paras = letter.split(/\n\s*\n/).filter((p) => p.trim());
    if (paras.length < 3 || paras.length > 4) err('letter', `${paras.length} paragraphs, spec is 3-4 separated by blank lines`);
    if (/^dear\b/i.test(letter)) err('letter', 'starts with a salutation (the renderer adds it)');
    if (/(?:regards|sincerely|yours|cheers),?\s*(?:anshu(?: madhikarmi)?)?\s*$/i.test(letter) || /anshu madhikarmi\s*$/i.test(letter)) {
      err('letter', 'ends with a sign-off (the renderer adds it)');
    }
    const mentions = (letter.match(companyRe) ?? []).length;
    if (mentions < 1 || mentions > 2) err('letter', `names ${app.company} ${mentions} times; once or twice is the rule`);
    for (const [re, name] of GAP_PHRASES) if (re.test(letter)) err('letter', name);
    if (/\bfreelanc\w*/i.test(letter) && !/\b(python|django)\b/i.test(jd)) err('letter', 'freelance Python/Django only when the JD values Python');
    textRules('letter', letter, errors);
    const lf = letterFacts(ledger, jd);
    for (const s of sentences(letter)) {
      numberRule('letter', s, lf, errors);
      toolRule('letter', s, ledger, jd, true, errors, warnings, true);
    }
    rhythmRule('letter', letter, errors);
  }

  /* ---- uniqueness ---- */
  const own = [
    ...sentences(app.summary).map((s) => ({ s, prose: true, where: 'summary' })),
    // Only the tailored parts must be unique per job. QA, Lab and Vosyn bullets are reused on purpose:
    // their wording is CareerSet-tested (8 Oct), and rewording the QA Bamboo bullet broke date parsing.
    ...bullets.filter((b) => b.ref === 'jdr-swe' || !roleIds.includes(b.ref)).map((b) => ({ s: b.text, prose: false, where: `${b.ref} "${b.label}"` })),
    ...(letter ? sentences(letter).map((s) => ({ s, prose: true, where: 'letter' })) : []),
  ];
  const opener = openerOf(app.summary);
  for (const doc of corpus) {
    if (opener && doc.opener && openerOf(doc.opener) === opener) err('summary', `opener "${opener}..." already used in ${doc.source}`);
    const exact = new Set(doc.sentences.map(normalizeSentence));
    for (const o of own) {
      if (wordCount(o.s) < 9) continue;
      if (exact.has(normalizeSentence(o.s))) {
        err(o.where, `sentence already used in ${doc.source}: "${o.s.slice(0, 80)}"`);
        continue;
      }
      if (o.prose && wordCount(o.s) >= 10) {
        const hit = doc.prose.find((p) => similarity(o.s, p) >= 0.5);
        if (hit) err(o.where, `near-duplicate of a sentence in ${doc.source}: "${hit.slice(0, 80)}"`);
      }
    }
  }

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/* ------------------------------------------------------------------ rules */

/** QA/SDET roles put the QA job first in weight (Anshu, 11 Oct): QA 6-8 bullets, Software Engineer 4-5. */
export function bulletRange(archetype: string, ref: string, ledger: { min: number; max: number }): { min: number; max: number } {
  if (archetype === 'quality-sdet' && ref === 'jdr-swe') return { min: 4, max: 5 };
  if (archetype === 'quality-sdet' && ref === 'jdr-qa') return { min: 6, max: 8 };
  return ledger;
}

export const QA_BAMBOO_BULLET =
  'Built Bamboo CI/CD jobs to manage QA environment deployments, data resets, and automated regression testing, running 2000+ test cases overnight with results synced to TestRail, cutting manual setup and local execution time for the team';

const IRREGULAR: Record<string, string> = {
  built: 'build', led: 'lead', wrote: 'write', written: 'write', ran: 'run', found: 'find', made: 'make',
  cut: 'cut', set: 'set', shipped: 'ship', taught: 'teach', brought: 'bring', drove: 'drive', chose: 'choose', chosen: 'choose',
};
const ACTION_VERBS = new Set(
  ('own build lead write find make cut set ship teach bring choose create develop design implement deliver resolve fix trace ' +
    'introduce validate mentor automate diagnose optimise optimize improve reduce migrate integrate maintain manage ' +
    'author analyse analyze coordinate launch establish refactor deploy configure architect co-author ' +
    'promote collaborate streamline identify investigate debug drive achieve ' +
    'replace switch follow apply construct produce prototype spearhead').split(/\s+/),
);
/** Count action verbs in any tense. Base forms only; nouns that share a verb's spelling (design) count too, as CareerSet does. */
export function actionVerbCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().match(/[a-z][a-z-]*/g) ?? []) {
    const cands = [IRREGULAR[raw], raw, raw.replace(/ies$/, 'y'), raw.replace(/ied$/, 'y'), raw.replace(/(?:ing|ed|es|s)$/, ''), raw.replace(/(?:d|s)$/, ''), raw.replace(/(.)\1(?:ing|ed)$/, '$1'), raw.replace(/ing$/, 'e')];
    const v = cands.find((c) => c && ACTION_VERBS.has(c));
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

function textRules(where: string, text: string, errors: string[]): void {
  for (const [re, name] of BANNED_WORDS) if (re.test(text)) errors.push(`${where}: banned ${name}`);
  for (const [re, name] of FORBIDDEN_CLAIMS) if (re.test(text)) errors.push(`${where}: ${name}`);
}

/**
 * Every number must come from a ledger fact, and the sentence carrying it
 * must share a content word with that fact. That's what stops 24h turning
 * into 48h, and the PR-review "100+" turning into "100+ automated tests".
 */
export function numberRule(where: string, text: string, facts: string[], errors: string[]): void {
  const nums = new Set(numbersIn(text));
  for (const n of nums) {
    const owners = facts.filter((f) => numbersIn(f).includes(n));
    if (owners.length === 0) {
      errors.push(`${where}: number ${n} is not in the ledger`);
      continue;
    }
    const near = contextOf(text, n);
    const ok = owners.some((f) => [...contextOf(f, n)].some((w) => near.has(w)));
    if (!ok) errors.push(`${where}: ${n} is used outside its ledger context ("${owners[0]}")`);
  }
}

/** Content words within a few words of each occurrence of number n: what the number is a number OF. */
function contextOf(text: string, n: string, span = 6): Set<string> {
  const tokens = text.split(/\s+/);
  const out = new Set<string>();
  tokens.forEach((t, i) => {
    if (!numbersIn(t).includes(n)) return;
    const window = tokens.slice(Math.max(0, i - span), i + span + 1).join(' ');
    for (const w of contentWords(window)) out.add(w);
  });
  return out;
}

/** jdOk: a tool the JD names may appear (as a warning) to describe the team's stack; letters and the summary only. */
function toolRule(where: string, text: string, ledger: Ledger, jd: string, jdOk: boolean, errors: string[], warnings: string[], isLetter = false): void {
  const allowed = (isLetter ? letterFacts(ledger, jd) : resumeFacts(ledger)).join(' \n ');
  const idx = skillIndex(ledger);
  for (const t of TECH_TERMS) {
    // Case-sensitive: tools are written in their own casing, and "express"/"rest"/"spark" are ordinary words.
    if (!termRe(t, '').test(text)) continue;
    if (termRe(t).test(allowed) || idx.has(t.toLowerCase())) continue;
    // "React Native" also matches "React"; only the longer term is the claim.
    if (jdOk && termRe(t).test(jd)) warnings.push(`${where}: names ${t} (from the JD, not the ledger). Fine for describing the team's stack or roadmap, never as Anshu's experience`);
    else errors.push(`${where}: names ${t}, which is not in the ledger`);
  }
}

function rhythmRule(where: string, text: string, errors: string[]): void {
  for (const m of text.matchAll(/\b([a-z]+), ([a-z]+),? and ([a-z]+)\b/gi)) {
    const hits = [m[1], m[2], m[3]].filter((w) => RHYTHM_ADJ.has(w.toLowerCase())).length;
    if (hits >= 2) errors.push(`${where}: rhythm triplet "${m[0]}"`);
  }
}

export function mentionsSkill(jd: string, name: string, ledger: Ledger): boolean {
  return [name, ...(ledger.aliases[name] ?? []), ...(ledger.jd_synonyms[name] ?? [])].some((n) => termRe(n).test(jd));
}

/** "Xero Limited" -> "Xero": the name as prose would use it. */
export function companyName(company: string): string {
  return company.replace(/\b(pty|ltd|limited|inc|llc|group|australia|holdings|corporation|corp|banking)\b\.?/gi, '').replace(/\s+/g, ' ').trim() || company;
}

function openerOf(text: string): string {
  return normalizeSentence(text).split(' ').slice(0, 5).join(' ');
}
