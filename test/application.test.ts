import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ApplicationSchema, checkApplication, numbersIn, type Application, type CorpusDoc } from '../src/core/application.js';
import { loadLedger } from '../src/core/ledger.js';

const ledger = loadLedger();
const jd = readFileSync('test/fixtures/application/jd.txt', 'utf8');
const base = ApplicationSchema.parse(JSON.parse(readFileSync('test/fixtures/application/application.json', 'utf8')));
const clone = (): Application => JSON.parse(JSON.stringify(base));
const run = (app: Application, extra: { letter?: string; corpus?: CorpusDoc[]; jd?: string } = {}) =>
  checkApplication({ app, ledger, jd: extra.jd ?? jd, letter: extra.letter, corpus: extra.corpus ?? [] });
const swe = (a: Application) => a.employment[0].bullets;

const letter = [
  "Xero's move to managed PostgreSQL puts query paths under a new kind of load, and finding slow ones is the work I most enjoy. At JDR Software I own 3 core modules from the React frontend down to the database.",
  'One response in our product took ~35s. I traced it to an N+1 query pattern, replaced the per-row lookups with batched DB calls, and added caching on top. The same response now comes back in under 1s, or 12ms when it is served from cache.',
  'Before engineering I spent a year in QA writing JMeter load and volume tests. Those runs validated 200,000 users and 500,000 bookings, then 1,000 bookings per second from 100 concurrent users, so I tend to measure a change under load before I call it done, and I keep the numbers.',
  'On the Database Reliability team I would bring that same habit of measuring first, plus the patience to trace a problem across systems. When a GraphQL data contract broke across systems, I followed it through Splunk and had a hotfix out within 24 hours of the report.',
].join('\n\n');

describe('checkApplication', () => {
  it('passes the reference application and letter', () => {
    const r = run(base, { letter });
    expect(r.errors).toEqual([]);
  });

  it('catches fact drift: a number not in the ledger, and a ledger number in the wrong context', () => {
    const a = clone();
    swe(a)[1].text = swe(a)[1].text.replace('24 hours', '48 hours');
    swe(a)[4] = { label: 'Automation', text: 'Wrote 100+ automated tests with the lowest defect rate on the team.' };
    const e = run(a).errors.join('\n');
    expect(e).toMatch(/number 48 is not in the ledger/);
    expect(e).toMatch(/100 is used outside its ledger context/);
  });

  it('rejects off-ledger tools, and skills placed above their confidence rating', () => {
    const a = clone();
    swe(a)[2].text += ' Deployed on Kubernetes with Kafka.';
    a.skills[1].items.push('Docker');
    a.skills[2].items.push('Python');
    const e = run(a).errors.join('\n');
    expect(e).toMatch(/names Kafka, which is not in the ledger/);
    expect(e).toMatch(/"Docker" is rated 2 or less/);
    expect(e).toMatch(/"Python" goes in a core row only when the JD asks/);
  });

  it('enforces the human-voice checklist', () => {
    const a = clone();
    a.summary = `Full Stack Software Engineer with ${a.summary}`;
    swe(a)[0].text = 'Spearheaded a fix — batched DB calls, ensuring reliability';
    swe(a)[2].text = 'Owned modules: frontend and backend, improving efficiency.';
    const e = run(a).errors.join('\n');
    expect(e).toMatch(/banned opener/);
    expect(e).toMatch(/banned spearheaded/);
    expect(e).toMatch(/banned em dash/);
    expect(e).toMatch(/colon inside bullet text/);
    expect(e).toMatch(/trailing benefit clause/);
  });

  it('forbids PR/citizenship, invented durations, freelance on the resume and tooling talk in the project', () => {
    const a = clone();
    swe(a)[2].text += ' Two years of professional React as a permanent resident.';
    a.employment[1].bullets[1].text += ' Also freelance Django.';
    a.projects = [{ ref: 'job-pipeline', bullets: [{ label: 'Docs', text: 'It also tailors each resume for the apply queue.' }, { label: 'Ingestion', text: 'Source adapters for Seek and LinkedIn behind one interface.' }] }];
    const e = run(a).errors.join('\n');
    expect(e).toMatch(/permanent residency/);
    expect(e).toMatch(/years-of-experience claim/);
    expect(e).toMatch(/freelance work never appears/);
    expect(e).toMatch(/application tooling/);
  });

  it('applies CV-scorer rules: pronouns, one sentence per bullet, lead-verb repetition, weak verbs', () => {
    const a = clone();
    swe(a)[0].text = 'Built the N+1 fix. It now returns fast.';
    swe(a)[1].text = 'Built a GraphQL hotfix through Splunk within 24 hours of the report.';
    swe(a)[2].text = 'Built 3 core modules end to end.';
    swe(a)[3].text = 'Worked on authentication with Spring Security.';
    const e = run(a).errors.join('\n');
    expect(e).toMatch(/personal pronoun "It"/);
    expect(e).toMatch(/more than one sentence/);
    expect(e).toMatch(/"built" leads \d bullets/);
    expect(e).toMatch(/weak verb "worked"/);
  });

  it('requires the posting title in the name-line headline', () => {
    const a = clone();
    a.headline = 'Backend Engineer';
    expect(run(a).errors.join('\n')).toMatch(/headline: must carry the posting's title/);
  });

  it('requires every ledger role, within its bullet budget', () => {
    const a = clone();
    a.employment = a.employment.filter((s) => s.ref !== 'vosyn');
    swe(a).splice(0, 3);
    const e = run(a).errors.join('\n');
    expect(e).toMatch(/role "vosyn" is missing/);
    expect(e).toMatch(/jdr-swe: 5 bullets, spec is 6-8/);
  });

  it('rejects reused openers and sentences from earlier documents', () => {
    const corpus: CorpusDoc[] = [
      {
        source: 'applications/old',
        opener: base.summary,
        sentences: [swe(base)[2].text],
        prose: ['Builds review and test tooling as a habit, from a Claude Code PR review workflow to JMeter load testing in a QA role, and scored 100 in a C#/.NET backend unit.'],
      },
    ];
    const e = run(base, { corpus }).errors.join('\n');
    expect(e).toMatch(/opener .* already used/);
    expect(e).toMatch(/sentence already used/);
    expect(e).toMatch(/near-duplicate/);
  });

  it('holds letters to length, gap phrases and company mentions', () => {
    const e = run(base, { letter: `Dear team,\n\nAlthough I lack Go, I am writing to apply.\n\nShort.` }).errors.join('\n');
    expect(e).toMatch(/letter: \d+ words, spec is 180-260/);
    expect(e).toMatch(/salutation/);
    expect(e).toMatch(/"although"/);
    expect(e).toMatch(/"I am writing to"/);
    expect(e).toMatch(/names Xero 0 times/);
  });

  it('reads digits and number words, but not unit codes or version suffixes', () => {
    expect(numbersIn('2,000+ tests, three cycles, SIT331, Vue3, ~35s')).toEqual(['2000', '35', '3']);
  });
});

import { actionVerbCounts } from '../src/core/application.js';
import { test as t2, expect as e2 } from 'vitest';
t2('action verbs counted across tenses (CareerSet repeat rule)', () => {
  const c = actionVerbCounts('Owns 3 modules. Own the schema. Owned the navbar. Built CI. Built a framework. Designing tables.');
  e2(c.get('own')).toBe(3);
  e2(c.get('build')).toBe(2);
  e2(c.get('design')).toBe(1);
});

import { headlineTitle } from '../src/core/stage-export.js';
t2('headlineTitle drops a trailing location', () => {
  e2(headlineTitle('Junior Software Engineer - South Bank, QLD')).toBe('Junior Software Engineer');
  e2(headlineTitle('Software Engineer | Melbourne')).toBe('Software Engineer');
  e2(headlineTitle('Full-Stack Developer - Remote')).toBe('Full-Stack Developer');
  e2(headlineTitle('Software Engineer - Platform')).toBe('Software Engineer - Platform');
});

t2('action verbs ending in -ate are counted (CareerSet flagged "Automated" x3)', () => {
  const c = actionVerbCounts('fully automated framework. automated regression testing. automated 150+ tests. Validated load. Created screens.');
  e2(c.get('automate')).toBe(3);
  e2(c.get('validate')).toBe(1);
  e2(c.get('create')).toBe(1);
});
