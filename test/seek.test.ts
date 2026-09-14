import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createSeekAdapter,
  extractJobPostingLd,
  extractNextDataDescription,
  extractJobAdHtml,
} from '../src/adapters/seek.js';
import { toJob, stripHtml } from '../src/core/normalize.js';
import type { AdapterContext, RawJob, RunOptions, SearchQuery } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));

const QUERY: SearchQuery = { query: 'software engineer', location: 'All Melbourne VIC', sources: ['seek'] };
const OPTS: RunOptions = { maxPages: 3, detail: false, dryRun: true };

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function fixture(): Promise<unknown> {
  return JSON.parse(await readFile(join(here, 'fixtures', 'seek-search.sample.json'), 'utf8'));
}

/** Serves the fixture for page 1 and an empty page after that. */
async function collect(pages: unknown[]): Promise<{ jobs: RawJob[]; urls: string[] }> {
  const urls: string[] = [];
  let call = 0;
  const ctx: AdapterContext = {
    logger: silentLogger,
    settings: {},
    http: {
      async getJson<T>(url: string): Promise<T> {
        urls.push(url);
        return (pages[call++] ?? { data: [] }) as T;
      },
      async getText(): Promise<string> {
        return '';
      },
    },
  };
  const adapter = createSeekAdapter(ctx);
  const jobs: RawJob[] = [];
  for await (const j of adapter.search(QUERY, OPTS)) jobs.push(j);
  return { jobs, urls };
}

describe('seek adapter', () => {
  it('maps every row in a real-shaped response', async () => {
    const { jobs } = await collect([await fixture()]);
    expect(jobs).toHaveLength(3);

    const first = jobs[0]!;
    expect(first.sourceId).toBe('84512377');
    expect(first.title).toBe('Software Engineer (Java / Spring Boot)');
    expect(first.company).toBe('Acme Software Pty Ltd');
    expect(first.locationRaw).toBe('Melbourne, CBD & Inner Suburbs');
    expect(first.salaryRaw).toBe('$110,000 – $130,000 + super');
    expect(first.employmentTypeRaw).toBe('Full time');
    expect(first.category).toBe('Developers/Programmers');
    expect(first.url).toBe('https://au.seek.com/job/84512377');
    expect(first.remoteHint).toBe(true); // "Hybrid" work arrangement
  });

  it('builds a search URL with the expected parameters', async () => {
    const { urls } = await collect([await fixture()]);
    const u = new URL(urls[0]!);
    expect(u.pathname).toBe('/api/jobsearch/v5/search');
    expect(u.searchParams.get('keywords')).toBe('software engineer');
    expect(u.searchParams.get('where')).toBe('All Melbourne VIC');
    expect(u.searchParams.get('page')).toBe('1');
    expect(u.searchParams.get('siteKey')).toBe('AU-Main');
  });

  it('stops at totalCount instead of paging forever', async () => {
    const { urls } = await collect([await fixture()]);
    expect(urls).toHaveLength(1);
  });

  it('stops on an empty page', async () => {
    const { jobs, urls } = await collect([{ data: [], totalCount: 0 }]);
    expect(jobs).toHaveLength(0);
    expect(urls).toHaveLength(1);
  });

  it('skips rows missing an id or title without killing the run', async () => {
    const { jobs } = await collect([
      { totalCount: 2, data: [{ title: 'No id here' }, { id: '5', title: 'Real Job' }] },
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.sourceId).toBe('5');
  });

  it('survives a field rename by degrading one field', async () => {
    const { jobs } = await collect([
      { totalCount: 1, data: [{ id: '7', title: 'Engineer', companyName: 'Renamed Co' }] },
    ]);
    expect(jobs[0]!.company).toBe('Renamed Co');
  });

  it('produces canonical Jobs end to end', async () => {
    const { jobs } = await collect([await fixture()]);
    const canonical = jobs.map((j) => toJob(j, 'seek', QUERY.query));

    expect(canonical[0]!.location.city).toBe('Melbourne');
    expect(canonical[0]!.salary?.min).toBe(110000);
    expect(canonical[0]!.employmentType).toBe('full-time');
    expect(canonical[0]!.tags).toContain('java');

    expect(canonical[1]!.salary).toBeUndefined();
    expect(canonical[1]!.tags).toContain('junior');

    expect(canonical[2]!.employmentType).toBe('contract');
    expect(canonical[2]!.salary?.period).toBe('day');

    expect(new Set(canonical.map((c) => c.id)).size).toBe(3);
  });
});

describe('seek adapter against a captured live response', () => {
  // This file is an actual response from the endpoint, captured 2026-09-05.
  // If Seek changes field names, this test is the one that will tell you —
  // it is not hand-built like the other fixture, so it can't drift to match
  // the adapter's assumptions.
  async function real(): Promise<unknown> {
    return JSON.parse(await readFile(join(here, 'fixtures', 'seek-search.real-2026-09-05.json'), 'utf8'));
  }

  it('maps every row, including a category from the nested classifications array', async () => {
    const { jobs } = await collect([await real()]);
    expect(jobs.length).toBeGreaterThan(0);

    const first = jobs[0]!;
    expect(first.sourceId).toBe('94423725');
    expect(first.title).toBe('Accounts Payable Officer');
    expect(first.company).toBe('YWCA Australia');
    expect(first.locationRaw).toBe('Surry Hills, Sydney NSW');
    expect(first.salaryRaw).toBe('$70,000 + super + salary up to $18,550!');
    expect(first.employmentTypeRaw).toBe('Full time');
    // Real shape nests this under classifications[0], with a lowercase-c
    // "subclassification" key that differs from the hand-built fixture above.
    expect(first.category).toBe('Accounts Payable');

    for (const j of jobs) {
      expect(j.category, `${j.title} should have a category`).toBeTruthy();
      expect(j.locationRaw).not.toMatch(/, AU$/); // countryCode must not leak into the location string
    }
  });

  it('normalizes cleanly end to end, including a $/hr and a blank-salary listing', async () => {
    const { jobs } = await collect([await real()]);
    const canonical = jobs.map((j) => toJob(j, 'seek', QUERY.query));

    const hourly = canonical.find((c) => c.sourceId === '94426937')!; // "AUD 38.89 per hour"
    expect(hourly.salary?.period).toBe('hour');
    expect(hourly.salary?.min).toBeCloseTo(38.89);

    const blank = canonical.find((c) => c.sourceId === '94424215')!; // salaryLabel: ""
    expect(blank.salary).toBeUndefined();

    const melbourne = canonical.find((c) => c.sourceId === '94409939')!; // Collingwood, Melbourne VIC
    expect(melbourne.location.city).toBe('Melbourne');
    expect(melbourne.location.state).toBe('VIC');
  });
});

describe('extractJobAdHtml', () => {
  // Shaped after a real job page capture (au.seek.com/job/94272826, 2026-09-05):
  // the ad body sits in a data-automation="jobAdDetails" wrapper containing
  // its own nested <div>, well before the closing </div> of any ancestor.
  const PAGE = `
    <html><body>
      <div class="_17onnmg0 tvnos959 tvnos9hh tvnos979">
        <nav>site nav, should not be captured</nav>
        <div class="_17onnmg0 tvnos959 tvnos9hh tvnos971">
          <div data-automation="jobAdDetails">
            <div class="_17onnmg0 _19m3coe0">
              <h2>Java Software Engineers | Mid-Level &amp; Senior</h2>
              <p><strong>Multiple Positions Available</strong><br><strong>Melbourne | Hybrid</strong></p>
              <p>We are currently looking for multiple Java Engineers across <strong>mid-level and senior levels</strong>.</p>
              <ul>
                <li>Building backend services using Java and Spring Boot</li>
                <li>Developing and integrating REST APIs</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
      <button data-automation="job-detail-apply">Quick apply</button>
    </body></html>`;

  it('extracts only the ad body, not surrounding page chrome', () => {
    const adHtml = extractJobAdHtml(PAGE)!;
    expect(adHtml).toContain('Java Software Engineers');
    expect(adHtml).toContain('Building backend services');
    expect(adHtml).not.toContain('site nav');
    expect(adHtml).not.toContain('Quick apply');
  });

  it('produces clean readable text once stripped', () => {
    const text = stripHtml(extractJobAdHtml(PAGE)!)!;
    expect(text).toContain('Java Software Engineers | Mid-Level & Senior');
    expect(text).toContain('- Building backend services using Java and Spring Boot');
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it('returns undefined when the marker is absent', () => {
    expect(extractJobAdHtml('<html><body>no ad here</body></html>')).toBeUndefined();
  });
});

describe('seek adapter fetchDetail', () => {
  function ctxWithPage(html: string): AdapterContext {
    return {
      logger: silentLogger,
      settings: {},
      http: {
        async getJson<T>(): Promise<T> {
          throw new Error('not used in this test');
        },
        async getText(): Promise<string> {
          return html;
        },
      },
    };
  }

  it('reads the description from JSON-LD when present', async () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      description: '<p>Full description here.</p>',
      employmentType: 'FULL_TIME',
    })}</script>`;
    const adapter = createSeekAdapter(ctxWithPage(html));
    const out = await adapter.fetchDetail!({ sourceId: '1', url: 'x', title: 't', company: 'c', locationRaw: '', raw: {} });
    expect(out.description).toContain('Full description here');
    expect(out.employmentTypeRaw).toBe('FULL_TIME');
  });

  it('falls back to __NEXT_DATA__ when there is no JSON-LD', async () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          job: {
            id: '555',
            content: '<p>Backend role.</p>' + 'x'.repeat(200) + '. More detail follows in this ad.',
          },
        },
      },
    })}</script>`;
    const adapter = createSeekAdapter(ctxWithPage(html));
    const out = await adapter.fetchDetail!({ sourceId: '555', url: 'x', title: 't', company: 'c', locationRaw: '', raw: {} });
    expect(out.description).toContain('Backend role');
  });

  it('returns nothing rather than throwing when neither source has a description', async () => {
    const adapter = createSeekAdapter(ctxWithPage('<html><body>Please enable JavaScript</body></html>'));
    const out = await adapter.fetchDetail!({ sourceId: '9', url: 'x', title: 't', company: 'c', locationRaw: '', raw: {} });
    expect(out.description).toBeUndefined();
  });
});

describe('extractNextDataDescription', () => {
  it('finds a description co-located with the matching job id', () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          jobDetails: { id: '42', description: 'A'.repeat(50) + '. Real ad content that is long enough. ' + 'B'.repeat(200) },
          related: [{ id: '999', description: 'C'.repeat(300) + '. A different job entirely.' }],
        },
      },
    })}</script>`;
    const desc = extractNextDataDescription(html, '42');
    expect(desc).toContain('Real ad content');
  });

  it('returns undefined when there is no __NEXT_DATA__ block', () => {
    expect(extractNextDataDescription('<html></html>', '1')).toBeUndefined();
  });

  it('ignores short strings so it does not pick up unrelated fields', () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { job: { id: '1', description: 'too short' } } },
    })}</script>`;
    expect(extractNextDataDescription(html, '1')).toBeUndefined();
  });
});

describe('extractJobPostingLd', () => {
  it('finds the JobPosting block among several', () => {
    const html = `
      <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Engineer","description":"<p>Build things</p>"}</script>`;
    const posting = extractJobPostingLd(html);
    expect(posting?.['title']).toBe('Engineer');
    expect(String(posting?.['description'])).toContain('Build things');
  });

  it('returns undefined when there is none', () => {
    expect(extractJobPostingLd('<html><body>nothing</body></html>')).toBeUndefined();
  });
});
