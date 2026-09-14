# Adding a job source

Four steps. Nothing outside these files changes.

1. `cp src/adapters/_template.ts src/adapters/<name>.ts`
2. Implement `search()` as an async generator yielding `RawJob`.
3. Register the factory in `src/adapters/registry.ts`.
4. Add a `sources.<name>` block to `config/config.json` and put the source in a
   search's `sources` array.

Normalization, cross-source dedupe, storage, ageing out, the CLI, exports and
the sanity check all work for the new source the moment it is registered.

## The contract

```ts
interface SourceAdapter {
  readonly name: string;
  search(query: SearchQuery, opts: RunOptions): AsyncGenerator<RawJob>;
  fetchDetail?(job: RawJob): Promise<Partial<RawJob>>;
  discover?(query: SearchQuery): Promise<unknown>;
}
```

Rules that keep the pipeline healthy:

- **Emit `RawJob`, not `Job`.** Salary strings, relative dates and messy location
  labels go through untouched. Interpreting them is `normalize.ts`'s job, and
  centralising it is why one salary-parsing fix improves every source at once.
- **Yield as you go.** Never buffer a whole run. A run that dies on page 12 must
  keep pages 1 to 11.
- **Every request goes through `ctx.http`.** That is what makes it rate limited,
  retried, backed off and cached. A direct `fetch()` bypasses all of it.
- **Site-specific and changeable things go in config**, not in code: endpoints,
  page size, site keys.
- **Fail loud.** If rows come back but none map, log a warning and stop. Silent
  zeroes are the classic scraper failure, and the pipeline's sanity check
  depends on you not swallowing them.
- **Always implement `discover()`** for a source with a private API. It is what
  turns "the scraper broke" into a two-minute fix.

## Writing the parser

Preference order, best first:

1. **A JSON endpoint the site's own frontend calls.** Seek, LinkedIn's guest
   API and most ATS platforms have one. No browser, no selectors.
2. **An embedded JSON blob in the HTML**: `__NEXT_DATA__`,
   `window.__APOLLO_STATE__`, `window.mosaic.providerData`, or a JSON-LD
   `JobPosting` block. Survives redesigns that break CSS selectors.
3. **CSS selectors.** Last resort. They break on every visual refresh.

## LinkedIn, when you get to it

Logged out only. The public guest endpoint carries no account risk; automating a
signed-in session is what gets accounts restricted, and LinkedIn detects it.

```
GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
    ?keywords=...&location=Melbourne%2C%20Victoria%2C%20Australia&f_TPR=r86400&start=0
```

- Returns an HTML fragment of `<li>` cards, not JSON. Add `cheerio` and parse
  it, or use a small regex pass; either way keep it inside the adapter.
- `start` increments by 10 or 25 and stops working somewhere near 1000.
- `f_TPR=r86400` limits to the last 24 hours, which is what a daily run wants.
- Detail: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{jobId}`.
- Rate limiting is the whole game: `minDelayMs` 3000+, `maxRequestsPerRun`
  around 100, and abort on the second 429. `HttpClient` already throws
  `BlockedError` on 403/429, and the pipeline already stops that source for the
  run when it sees one.

## Indeed, when you get to it

Only after the other two work.

- Needs Playwright: `npm i playwright playwright-extra puppeteer-extra-plugin-stealth`.
- `chromium.launchPersistentContext('./data/.chrome-profile')`, and
  `headless: false`. Solve the Cloudflare challenge by hand once; the clearance
  cookie then survives for days. That trick is only available because this runs
  locally, and it is most of what a paid scraping platform is charging for.
- Results live in `window.mosaic.providerData["mosaic-provider-jobcards"]`.
  Read it with `page.evaluate`, do not scrape the DOM.
- Give the adapter its own browser lifecycle: launch in `search()`, close in a
  `finally`. Do not add a browser to `HttpClient`; keep it in the one adapter
  that needs it.
- If it fails more often than it works, drop it. Cost and reliability are both
  bad, and Seek plus LinkedIn cover most of the AU market.

## Testing a new adapter

Copy `test/seek.test.ts`. It builds an `AdapterContext` with a fake `http` that
returns a fixture, so tests are offline, fast and deterministic.

Save one real response into `test/fixtures/` (`npm run discover` writes exactly
that file for you). Assert on the mapped fields, the search URL, pagination
stopping, and a row missing required fields being skipped rather than crashing.
When the site changes, a test goes red and names the parser to fix. That is the
difference between ten minutes of maintenance and a rewrite.
