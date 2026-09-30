import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createLinkedInAdapter,
  extractJobCards,
  extractDescriptionHtml,
  extractJobCriteria,
  extractLinkedInApplyMethod,
} from '../src/adapters/linkedin.js';
import { toJob } from '../src/core/normalize.js';
import type { AdapterContext, RawJob, RunOptions, SearchQuery } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));

const QUERY: SearchQuery = { query: 'software engineer', location: 'All Melbourne VIC', sources: ['linkedin'] };
const OPTS: RunOptions = { maxPages: 3, detail: false, dryRun: true };

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function realFixture(): Promise<{ url: string; html: string }> {
  return JSON.parse(
    await readFile(join(here, 'fixtures', 'linkedin-search.real-2026-09-10.json'), 'utf8'),
  );
}

/** Serves each page's HTML in order, then an empty fragment after that. */
async function collect(pages: string[]): Promise<{ jobs: RawJob[]; urls: string[] }> {
  const urls: string[] = [];
  let call = 0;
  const ctx: AdapterContext = {
    logger: silentLogger,
    settings: {},
    http: {
      async getJson<T>(): Promise<T> {
        throw new Error('linkedin adapter should never call getJson for search');
      },
      async getText(url: string): Promise<string> {
        urls.push(url);
        return pages[call++] ?? '';
      },
    },
  };
  const adapter = createLinkedInAdapter(ctx);
  const jobs: RawJob[] = [];
  for await (const j of adapter.search(QUERY, OPTS)) jobs.push(j);
  return { jobs, urls };
}

// A trimmed two-card fragment shaped after a real guest search response
// (captured via `npm run discover -- --source linkedin` on 2026-09-10, see
// fixtures/linkedin-search.real-2026-09-10.json for the untouched capture).
// Whitespace collapsed for readability; class names, attribute names and
// nesting kept exactly as LinkedIn returned them.
const SAMPLE_PAGE = `
<li>
  <div class="base-card relative w-full base-search-card base-search-card--link job-search-card" data-entity-urn="urn:li:jobPosting:4464147270" data-tracking-id="p0jtI+QeT+E4IhFKXV5Pww==">
    <a class="base-card__full-link" href="https://au.linkedin.com/jobs/view/full-stack-engineer-at-sigma-healthcare-4464147270?position=1&amp;trackingId=x">
      <span class="sr-only">Full Stack Engineer</span>
    </a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title">
        Full Stack Engineer
      </h3>
      <h4 class="base-search-card__subtitle">
        <a class="hidden-nested-link" href="https://au.linkedin.com/company/sigma-healthcare">
          Sigma Healthcare
        </a>
      </h4>
      <div class="base-search-card__metadata">
        <span class="job-search-card__location">
          Preston, Victoria, Australia
        </span>
        <time class="job-search-card__listdate--new" datetime="2026-09-09">
          6 hours ago
        </time>
      </div>
    </div>
  </div>
</li>
<li>
  <div class="base-card relative w-full base-search-card base-search-card--link job-search-card" data-entity-urn="urn:li:jobPosting:4463879282" data-tracking-id="abc123==">
    <a class="base-card__full-link" href="https://au.linkedin.com/jobs/view/software-engineer-at-ncino-4463879282?position=2&amp;trackingId=y">
      <span class="sr-only">Software Engineer</span>
    </a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title">
        Software Engineer
      </h3>
      <h4 class="base-search-card__subtitle">
        <a class="hidden-nested-link" href="https://au.linkedin.com/company/ncino">
          nCino
        </a>
      </h4>
      <div class="base-search-card__metadata">
        <span class="job-search-card__location">
          Melbourne, Victoria, Australia
        </span>
        <time class="job-search-card__listdate--new" datetime="2026-09-08">
          1 day ago
        </time>
      </div>
    </div>
  </div>
</li>
`;

describe('linkedin adapter', () => {
  it('maps every card in a real-shaped response', async () => {
    const { jobs } = await collect([SAMPLE_PAGE]);
    expect(jobs).toHaveLength(2);

    const first = jobs[0]!;
    expect(first.sourceId).toBe('4464147270');
    expect(first.title).toBe('Full Stack Engineer');
    expect(first.company).toBe('Sigma Healthcare');
    expect(first.locationRaw).toBe('Preston, Victoria, Australia');
    expect(first.postedAtRaw).toBe('2026-09-09'); // from <time datetime="...">, not the relative "6 hours ago" text
    expect(first.url).toBe('https://www.linkedin.com/jobs/view/4464147270');
    expect(first.salaryRaw).toBeUndefined(); // guest cards rarely show one; must not be invented
  });

  it('builds a search URL with the expected parameters', async () => {
    const { urls } = await collect([SAMPLE_PAGE]);
    const u = new URL(urls[0]!);
    expect(u.pathname).toBe('/jobs-guest/jobs/api/seeMoreJobPostings/search');
    expect(u.searchParams.get('keywords')).toBe('software engineer');
    expect(u.searchParams.get('location')).toBe('All Melbourne VIC');
    expect(u.searchParams.get('start')).toBe('0');
    expect(u.searchParams.get('f_TPR')).toBe('r86400');
  });

  it('stops paging once a page returns fewer cards than pageSize', async () => {
    // Default pageSize is 25; this 2-card page is short, so a second
    // request must never happen even though maxPages allows more.
    const { urls } = await collect([SAMPLE_PAGE, SAMPLE_PAGE]);
    expect(urls).toHaveLength(1);
  });

  it('stops on an empty page', async () => {
    const { jobs, urls } = await collect(['']);
    expect(jobs).toHaveLength(0);
    expect(urls).toHaveLength(1);
  });

  it('skips a card missing an id or title without killing the run', async () => {
    const noId = '<li><div class="base-search-card"><h3 class="base-search-card__title">No id here</h3></div></li>';
    const noTitle = '<li><div class="base-search-card" data-entity-urn="urn:li:jobPosting:9"></div></li>';
    const real =
      '<li><div class="base-search-card" data-entity-urn="urn:li:jobPosting:5"><h3 class="base-search-card__title">Real Job</h3></div></li>';
    const { jobs } = await collect([noId + noTitle + real]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.sourceId).toBe('5');
  });

  it('falls back to the job id in the card href when data-entity-urn is missing', async () => {
    const card =
      '<li><div class="base-search-card"><a class="base-card__full-link" href="https://au.linkedin.com/jobs/view/backend-engineer-at-acme-9988776/?position=1"></a><h3 class="base-search-card__title">Backend Engineer</h3></div></li>';
    const { jobs } = await collect([card]);
    expect(jobs[0]!.sourceId).toBe('9988776');
  });

  it('flags remote/hybrid roles from the location text', async () => {
    const card =
      '<li><div class="base-search-card" data-entity-urn="urn:li:jobPosting:1"><h3 class="base-search-card__title">Remote Engineer</h3><span class="job-search-card__location">Australia (Remote)</span></div></li>';
    const { jobs } = await collect([card]);
    expect(jobs[0]!.remoteHint).toBe(true);
  });

  it('produces canonical Jobs end to end', async () => {
    const { jobs } = await collect([SAMPLE_PAGE]);
    const canonical = jobs.map((j) => toJob(j, 'linkedin', QUERY.query));

    // "Preston, Victoria, Australia" isn't a recognised Melbourne-metro
    // label or CITY_STATE key, so normalize.ts falls back to the first
    // comma segment for city while still finding the state from "Victoria".
    expect(canonical[0]!.location.city).toBe('Preston');
    expect(canonical[0]!.location.state).toBe('VIC');
    // Search cards never carry an employment-type string (only fetchDetail
    // does, via the criteria list) — this documents that real behaviour
    // rather than letting it silently regress.
    expect(canonical[0]!.employmentType).toBe('unknown');

    expect(canonical[1]!.location.city).toBe('Melbourne');
    expect(new Set(canonical.map((c) => c.id)).size).toBe(2);
  });
});

describe('linkedin adapter against a captured live response', () => {
  // An actual response from the guest search endpoint, captured 2026-09-10
  // via `npm run discover -- --source linkedin`. Unlike SAMPLE_PAGE above
  // this isn't hand-built, so it can't drift to match the adapter's
  // assumptions — if LinkedIn changes its markup, this is the test that
  // will tell you.
  it('maps every card in the real response', async () => {
    const { html } = await realFixture();
    const { jobs } = await collect([html]);
    expect(jobs.length).toBeGreaterThan(0);

    const first = jobs[0]!;
    expect(first.sourceId).toBe('4464147270');
    expect(first.title).toBe('Full Stack Engineer');
    expect(first.company).toBe('Sigma Healthcare');
    expect(first.locationRaw).toBe('Preston, Victoria, Australia');
    expect(first.postedAtRaw).toBe('2026-09-09');
    expect(first.url).toBe('https://www.linkedin.com/jobs/view/4464147270');

    for (const j of jobs) {
      expect(j.sourceId, `${j.title} should have a numeric sourceId`).toMatch(/^\d+$/);
      expect(j.title.length).toBeGreaterThan(0);
      expect(j.company).not.toBe('');
    }
    expect(new Set(jobs.map((j) => j.sourceId)).size).toBe(jobs.length);
  });

  it('extracts exactly as many cards as the fragment contains', async () => {
    const { html } = await realFixture();
    // Independently confirmed via grep on the raw capture: 10 <li> cards,
    // 10 data-entity-urn attributes.
    expect(extractJobCards(html)).toHaveLength(10);
  });
});

// A trimmed detail fragment shaped after a real
// `jobs-guest/jobs/api/jobPosting/{id}` response, captured 2026-09-10.
const REAL_SHAPED_DETAIL = `
  <div class="description__text description__text--rich">
    <section class="show-more-less-html" data-max-lines="5">
      <div class="show-more-less-html__markup show-more-less-html__markup--clamp-after-5
          relative overflow-hidden">
        <p><strong>About the Role</strong></p>
        <p>Build and maintain production services.</p>
      </div>
    </section>
  </div>
  <ul class="description__job-criteria-list">
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader">
        Seniority level
      </h3>
      <span class="description__job-criteria-text description__job-criteria-text--criteria">
        Mid-Senior level
      </span>
    </li>
    <li class="description__job-criteria-item">
      <h3 class="description__job-criteria-subheader">
        Employment type
      </h3>
      <span class="description__job-criteria-text description__job-criteria-text--criteria">
        Full-time
      </span>
    </li>
  </ul>`;

describe('extractJobCards', () => {
  it('splits a fragment into one entry per <li>, keeping cards independent', () => {
    const cards = extractJobCards(SAMPLE_PAGE);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('Full Stack Engineer');
    expect(cards[0]).not.toContain('nCino');
    expect(cards[1]).toContain('nCino');
  });

  it('returns an empty array for a fragment with no cards', () => {
    expect(extractJobCards('<div>nothing here</div>')).toEqual([]);
  });
});

describe('extractDescriptionHtml', () => {
  it('extracts only the description body, not the criteria list after it', () => {
    const html = extractDescriptionHtml(REAL_SHAPED_DETAIL)!;
    expect(html).toContain('Build and maintain production services');
    expect(html).not.toContain('Seniority level');
  });

  it('returns undefined when the marker is absent', () => {
    expect(extractDescriptionHtml('<html><body>no description here</body></html>')).toBeUndefined();
  });
});

describe('extractJobCriteria', () => {
  it('reads label -> value pairs with lowercased labels', () => {
    const criteria = extractJobCriteria(REAL_SHAPED_DETAIL);
    expect(criteria['employment type']).toBe('Full-time');
    expect(criteria['seniority level']).toBe('Mid-Senior level');
  });

  it('returns an empty object when there is no criteria list', () => {
    expect(extractJobCriteria('<html></html>')).toEqual({});
  });
});

describe('linkedin adapter fetchDetail', () => {
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

  it('reads the description and employment type from a real-shaped detail fragment', async () => {
    const adapter = createLinkedInAdapter(ctxWithPage(REAL_SHAPED_DETAIL));
    const out = await adapter.fetchDetail!({
      sourceId: '1',
      url: 'https://www.linkedin.com/jobs/view/1',
      title: 't',
      company: 'c',
      locationRaw: '',
      raw: {},
    });
    expect(out.description).toContain('Build and maintain production services');
    expect(out.employmentTypeRaw).toBe('Full-time');
  });

  it('falls back to JSON-LD when there is no show-more-less-html__markup block', async () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      description: '<p>Full description here.</p>',
    })}</script>`;
    const adapter = createLinkedInAdapter(ctxWithPage(html));
    const out = await adapter.fetchDetail!({
      sourceId: '1',
      url: 'x',
      title: 't',
      company: 'c',
      locationRaw: '',
      raw: {},
    });
    expect(out.description).toContain('Full description here');
  });

  it('returns nothing rather than throwing when neither source has a description', async () => {
    const adapter = createLinkedInAdapter(ctxWithPage('<html><body>Please enable JavaScript</body></html>'));
    const out = await adapter.fetchDetail!({ sourceId: '9', url: 'x', title: 't', company: 'c', locationRaw: '', raw: {} });
    expect(out.description).toBeUndefined();
  });
});

describe('extractLinkedInApplyMethod', () => {
  const btn = (name: string) => `<button class="apply-button" data-tracking-control-name="public_jobs_apply-link-${name}">`;
  it('onsite and simple are Easy Apply, offsite is external', () => {
    expect(extractLinkedInApplyMethod(btn('onsite'))).toBe('easy_apply');
    expect(extractLinkedInApplyMethod(btn('simple'))).toBe('easy_apply');
    expect(extractLinkedInApplyMethod(btn('offsite'))).toBe('external');
  });
  it('no apply button (closed listing) stays unknown', () => {
    expect(extractLinkedInApplyMethod('<div>No longer accepting applications</div>')).toBeUndefined();
  });
});
