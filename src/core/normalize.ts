import type {
  EmploymentType,
  Job,
  JobLocation,
  RawJob,
  Salary,
  SourceName,
} from './types.js';
import { makeFingerprint, makeId } from './dedupe.js';

/* ------------------------------------------------------------------ salary */

/**
 * Detected before the AU-only state/city logic below, which only ever
 * produces AU output. LinkedIn (unlike Seek) returns jobs from any country,
 * and it puts the country name in the location string, so a straight
 * keyword match is enough — no need for a per-search "market" flag, since
 * the actual posting's location is the real source of truth for which
 * country a job belongs to. Order matters where a name-only fallback could
 * otherwise clash with a country name that also appears (country checks
 * first, city fallbacks after).
 */
const COUNTRY_HINTS: Array<[RegExp, string]> = [
  [/\bnew zealand\b/i, 'NZ'],
  [/\bireland\b/i, 'IE'],
  [/\b(united kingdom|england|scotland|northern ireland|uk)\b/i, 'GB'],
  [/\bgermany\b/i, 'DE'],
  [/\b(netherlands|holland)\b/i, 'NL'],
  [/\bcanada\b/i, 'CA'],
  [/\bsingapore\b/i, 'SG'],
  [/\b(united arab emirates|uae)\b/i, 'AE'],
  [/\baustralia\b/i, 'AU'],
  // City-level fallbacks for when the source omits the country name itself.
  [/\b(auckland|wellington|christchurch)\b/i, 'NZ'],
  [/\bdublin\b/i, 'IE'],
  [/\b(london|manchester|birmingham|edinburgh|glasgow)\b/i, 'GB'],
  [/\b(berlin|munich|m\u00fcnchen|hamburg|frankfurt)\b/i, 'DE'],
  [/\b(amsterdam|rotterdam|utrecht|the hague|den haag)\b/i, 'NL'],
  [/\b(toronto|vancouver|montreal|ottawa|calgary)\b/i, 'CA'],
  [/\b(dubai|abu dhabi|sharjah)\b/i, 'AE'],
];

function detectCountry(text: string): string {
  for (const [rx, code] of COUNTRY_HINTS) {
    if (rx.test(text)) return code;
  }
  // Fallback: Seek is AU-only and its strings never spell out "Australia",
  // so anything that matched none of the above is assumed AU rather than
  // left unknown.
  return 'AU';
}

const AU_STATES: Record<string, string> = {
  vic: 'VIC',
  victoria: 'VIC',
  nsw: 'NSW',
  'new south wales': 'NSW',
  qld: 'QLD',
  queensland: 'QLD',
  wa: 'WA',
  'western australia': 'WA',
  sa: 'SA',
  'south australia': 'SA',
  tas: 'TAS',
  tasmania: 'TAS',
  act: 'ACT',
  'australian capital territory': 'ACT',
  nt: 'NT',
  'northern territory': 'NT',
};

/** Melbourne metro labels Seek uses, mapped to one canonical city. */
const MELBOURNE_AREAS = [
  'cbd & inner suburbs',
  'eastern suburbs',
  'western suburbs',
  'northern suburbs',
  'south eastern suburbs',
  'bayside & south eastern suburbs',
  'melbourne',
];

/** Major AU cities and their state, used to fill in a missing state code. */
const CITY_STATE: Record<string, string> = {
  melbourne: 'VIC',
  geelong: 'VIC',
  ballarat: 'VIC',
  bendigo: 'VIC',
  sydney: 'NSW',
  newcastle: 'NSW',
  wollongong: 'NSW',
  'central coast': 'NSW',
  brisbane: 'QLD',
  'gold coast': 'QLD',
  'sunshine coast': 'QLD',
  cairns: 'QLD',
  townsville: 'QLD',
  perth: 'WA',
  adelaide: 'SA',
  canberra: 'ACT',
  hobart: 'TAS',
  launceston: 'TAS',
  darwin: 'NT',
};

const PERIOD_HINTS: Array<[RegExp, Salary['period']]> = [
  [/\b(p\.?a\.?|per\s*annum|annual|year|yr)\b/i, 'year'],
  [/\b(per\s*month|p\.?m\.?|month)\b/i, 'month'],
  [/\b(per\s*day|p\.?d\.?|daily|\/\s*day|day\s*rate)\b/i, 'day'],
  [/\b(per\s*hour|p\.?h\.?|hourly|\/\s*hr|\/\s*hour|hour)\b/i, 'hour'],
];

/**
 * Parse the many shapes an AU salary string takes:
 *   "$120,000 - $140,000 + super", "120k-140k", "$700/day", "$65 p.h.",
 *   "Up to $150,000", "$95,000 – $110,000 pa"
 * Returns undefined rather than guessing when nothing numeric is present.
 * Roughly 40% of AU listings hide salary, so missing must never mean zero.
 */
export function parseSalary(raw?: string): Salary | undefined {
  if (!raw) return undefined;
  const text = raw.replace(/–|—/g, '-').trim();
  if (!text) return undefined;

  // Determine the period before filtering numbers: "AUD 38.89 per hour" has
  // no "$" in front of the number, but "per hour" is enough to know 38.89 is
  // real money, not a stray count. A currency word counts the same as "$".
  let period: Salary['period'] = 'unknown';
  for (const [rx, p] of PERIOD_HINTS) {
    if (rx.test(text)) {
      period = p;
      break;
    }
  }
  const hasCurrencyWord = /\b(aud|nzd|usd)\b/i.test(text);

  const numbers: number[] = [];
  const re = /(\$?\s*)(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const hadDollar = (m[1]?.includes('$') ?? false) || hasCurrencyWord;
    const digits = (m[2] ?? '').replace(/,/g, '');
    if (!digits) continue;
    let value = Number(digits);
    if (!Number.isFinite(value)) continue;
    if (m[3]) value *= 1000;
    // Bare years / counts like "2026" or "5 years experience" are not
    // salaries — unless a period was found (an hourly/daily rate can
    // legitimately be a small number with no "$", e.g. "38.89 per hour").
    if (!hadDollar && !m[3] && period === 'unknown' && value < 1000) continue;
    numbers.push(value);
  }

  if (numbers.length === 0) return undefined;

  if (period === 'unknown') {
    const max = Math.max(...numbers);
    if (max >= 20_000) period = 'year';
    else if (max >= 300) period = 'day';
    else if (max <= 250) period = 'hour';
  }

  const sorted = [...numbers].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const upToOnly = /\b(up to|max(imum)?)\b/i.test(text) && numbers.length === 1;

  const salary: Salary = { currency: 'AUD', period, raw: text };
  if (upToOnly) {
    salary.max = max;
  } else {
    salary.min = min;
    if (max !== min) salary.max = max;
  }
  return salary;
}

/* ---------------------------------------------------------------- location */

export function parseLocation(raw: string, remoteHint = false): JobLocation {
  const text = (raw ?? '').trim();
  const lower = text.toLowerCase();
  const remote = remoteHint || /\b(remote|work from home|wfh|anywhere)\b/i.test(text);

  let state: string | undefined;
  for (const [needle, code] of Object.entries(AU_STATES)) {
    const rx = new RegExp(`(^|[\\s,(/-])${escapeRegex(needle)}($|[\\s,)/-])`, 'i');
    if (rx.test(lower)) {
      state = code;
      break;
    }
  }

  let city: string | undefined;
  if (MELBOURNE_AREAS.some((a) => lower.includes(a))) city = 'Melbourne';
  else {
    const hit = Object.keys(CITY_STATE).find((k) => lower.includes(k));
    if (hit) city = titleCase(hit);
    else {
      // Fall back to the first comma-separated segment that is not a state code.
      const first = text.split(/[,|]/)[0]?.trim();
      if (first && !AU_STATES[first.toLowerCase()]) city = first || undefined;
    }
  }

  // Seek's metro labels ("Melbourne, CBD & Inner Suburbs") often omit the
  // state, so infer it from a known city rather than leaving the field empty.
  if (!state && city) state = CITY_STATE[city.toLowerCase()];

  const loc: JobLocation = { raw: text, country: detectCountry(text), remote };
  if (city) loc.city = city;
  if (state) loc.state = state;
  return loc;
}

/* -------------------------------------------------------------------- date */

/**
 * Sources give ISO strings, "3d ago", "30+ days ago", "Posted 2 hours ago".
 * Convert relative to absolute at scrape time, never at read time.
 */
export function parseDate(raw?: string, now = new Date()): string | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (!text) return undefined;

  const iso = Date.parse(text);
  if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}|\d{1,2}\s\w{3}\s\d{4}/.test(text)) {
    return new Date(iso).toISOString();
  }

  const rel = /(\d+)\s*\+?\s*(minute|min|hour|hr|day|d|week|w|month|mo)s?\s*(ago)?/i.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = (rel[2] ?? '').toLowerCase();
    const ms =
      unit.startsWith('min') ? n * 60_000
      : unit.startsWith('h') ? n * 3_600_000
      : unit === 'd' || unit.startsWith('day') ? n * 86_400_000
      : unit === 'w' || unit.startsWith('week') ? n * 7 * 86_400_000
      : n * 30 * 86_400_000;
    return new Date(now.getTime() - ms).toISOString();
  }

  if (/just posted|today|new/i.test(text)) return now.toISOString();
  if (/yesterday/i.test(text)) return new Date(now.getTime() - 86_400_000).toISOString();

  return Number.isNaN(iso) ? undefined : new Date(iso).toISOString();
}

export function daysSince(iso?: string, now = new Date()): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return (now.getTime() - t) / 86_400_000;
}

/* ------------------------------------------------------- employment + tags */

export function parseEmploymentType(raw?: string, title?: string): EmploymentType {
  const text = `${raw ?? ''} ${title ?? ''}`.toLowerCase();
  if (/intern(ship)?|graduate program|trainee/.test(text)) return 'internship';
  if (/casual/.test(text)) return 'casual';
  if (/contract|temp|fixed[ -]term|daily rate|day rate/.test(text)) return 'contract';
  if (/part[ -]time/.test(text)) return 'part-time';
  if (/full[ -]time|permanent|perm\b/.test(text)) return 'full-time';
  return 'unknown';
}

/**
 * Keyword extraction. Deliberately a fixed list: cheap, deterministic, editable.
 *
 * Scope matters. "mentored by senior engineers" in a teaser must not tag a
 * junior role as senior, so seniority is read from the title only.
 */
export type TagScope = 'title' | 'any';
export const TAG_VOCAB: Array<[string, RegExp, TagScope?]> = [
  ['java', /\bjava\b(?!script)/i],
  ['spring', /\bspring( boot)?\b/i],
  ['kotlin', /\bkotlin\b/i],
  ['typescript', /\btypescript\b|\bts\b(?=[ ,/)])/i],
  ['javascript', /\bjavascript\b|\bjs\b(?=[ ,/)])/i],
  ['react', /\breact(\.js)?\b/i],
  ['angular', /\bangular\b/i],
  ['vue', /\bvue(\.js)?\b/i],
  ['node', /\bnode(\.js)?\b/i],
  ['python', /\bpython\b/i],
  ['csharp', /\bc#|\.net\b|dotnet/i],
  ['go', /\bgolang\b|\bgo\b(?= developer| engineer)/i],
  ['sql', /\bsql\b/i],
  ['postgres', /\bpostgres(ql)?\b/i],
  ['mysql', /\bmysql\b/i],
  ['mongodb', /\bmongo(db)?\b/i],
  ['aws', /\baws\b|amazon web services/i],
  ['azure', /\bazure\b/i],
  ['gcp', /\bgcp\b|google cloud/i],
  ['docker', /\bdocker\b/i],
  ['kubernetes', /\bkubernetes\b|\bk8s\b/i],
  ['terraform', /\bterraform\b/i],
  ['graphql', /\bgraphql\b/i],
  ['rest', /\brest(ful)? api/i],
  ['microservices', /\bmicroservice/i],
  ['ci-cd', /\bci\/cd\b|jenkins|github actions|gitlab ci/i],
  [
    'testing',
    /\bqa\b|automat(?:ed|ion) test(?:ing)?|test automation|selenium|cypress|playwright|junit|jest/i,
  ],
  ['agile', /\bagile\b|\bscrum\b/i],
  ['junior', /\bjunior\b|\bjnr\b|\bgraduate\b|\bentry[ -]level\b/i, 'title'],
  ['mid', /\bmid[ -]level\b|\bintermediate\b/i, 'title'],
  ['senior', /\bsenior\b|\bsnr\b|\blead\b|\bprincipal\b|\bstaff engineer\b/i, 'title'],
  ['hybrid', /\bhybrid\b/i],
  ['remote', /\bremote\b|work from home/i],
  ['visa-sponsorship', /visa sponsor|sponsorship (is )?(available|offered)|482|tss visa/i],
  ['citizen-only', /must be (an )?australian citizen|citizens? only|security clearance|nv1|baseline clearance/i],
];

/** First argument is the job title; the rest is body text. */
export function extractTags(title: string | undefined, ...body: Array<string | undefined>): string[] {
  const titleText = title ?? '';
  const allText = [titleText, ...body].filter(Boolean).join(' \n ');
  if (!allText.trim()) return [];
  const out: string[] = [];
  for (const [tag, rx, scope] of TAG_VOCAB) {
    const haystack = scope === 'title' ? titleText : allText;
    if (rx.test(haystack)) out.push(tag);
  }
  return out;
}

/* -------------------------------------------------------------------- html */

export function stripHtml(html?: string): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || undefined;
}

/* ------------------------------------------------------------------ to Job */

export function toJob(rawJob: RawJob, source: SourceName, query: string, now = new Date()): Job {
  const location = parseLocation(rawJob.locationRaw, rawJob.remoteHint);
  const title = collapse(rawJob.title);
  const company = collapse(rawJob.company);
  const nowIso = now.toISOString();
  const description = rawJob.description ? stripHtml(rawJob.description) : undefined;

  const job: Job = {
    id: makeId(source, rawJob.sourceId),
    fingerprint: makeFingerprint(title, company, location.city ?? location.raw),
    source,
    sourceId: rawJob.sourceId,
    url: rawJob.url,
    title,
    company,
    location,
    scrapedAt: nowIso,
    lastSeenAt: nowIso,
    missedRuns: 0,
    closed: false,
    employmentType: parseEmploymentType(rawJob.employmentTypeRaw, title),
    tags: extractTags(title, rawJob.teaser, description, rawJob.employmentTypeRaw),
    seenOn: [source],
    matchedQueries: query ? [query] : [],
    // Every freshly-scraped job starts here. If this job already exists in
    // the store, mergeJob() in dedupe.ts keeps the EXISTING pipelineStatus
    // and statusHistory rather than these — a re-scrape must never rewind a
    // job that a downstream stage has already judged.
    pipelineStatus: 'scraped',
    statusHistory: [],
    raw: { [source]: rawJob.raw },
  };

  const postedAt = parseDate(rawJob.postedAtRaw, now);
  if (postedAt) job.postedAt = postedAt;
  const salary = parseSalary(rawJob.salaryRaw);
  if (salary) job.salary = salary;
  if (rawJob.category) job.category = rawJob.category;
  if (rawJob.teaser) job.teaser = collapse(rawJob.teaser);
  if (description) job.description = description;
  if (rawJob.applyMethod) job.applyMethod = rawJob.applyMethod;

  return job;
}

/* ----------------------------------------------------------------- helpers */

export function collapse(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
