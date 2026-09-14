# job-scraper

Local job scraper. Runs on your machine, writes to a JSON file, costs nothing.

Seek is implemented. LinkedIn, Indeed and anything else plug in behind a single
`SourceAdapter` interface without touching the pipeline, store or CLI.

This is a five-stage pipeline: scrape → an LLM agent judges fit against your
resume → good-fit roles get added to a Google Sheet tracker → an LLM agent
tailors a career profile/technical skills blurb per job → a second LLM agent
drafts a cover letter per job (only once that job already has a career
profile) → you apply. Everything in *this* repo is the deterministic,
zero-LLM plumbing that makes the agent stages cheap to run unattended on a
schedule: it decides what each agent is allowed to see, and no agent ever has
to read `jobs.json` itself to figure that out. Anshu's own manual tracking —
the Applied checkbox and the Stages dropdown (Take home / Initial Screen /
Final Round / Offer / NA / Invalid) — is read back by `sync-sheet` too: once
either is set on a row, that job stops being sent to any agent, full stop,
regardless of pipelineStatus. See "Pipeline architecture" below.

```
config/config.json ──> CLI ──> SourceAdapter (seek) ──> RawJob
                                     │
                             HttpClient (rate limit, retry, disk cache)
                                     │
                       normalize ──> dedupe ──> JsonStore (master, permanent)
                                                   │
                                     data/jobs.json + data/runs/*.json
                                                   │
                              plain-code filter (no LLM) ── export-fit-inbox
                                                   │
                                     data/stage/fit-filter-inbox.json (small, disposable)
                                                   │
                                    [fit-filter agent reads this, writes verdicts]
                                                   │
                              plain-code write-back (no LLM) ── apply-fit-verdicts
                                                   │
                                  master updated: pipelineStatus -> fit_good / fit_bad
                                                   │
                              plain-code filter (no LLM) ── export-tracker-inbox
                                                   │
                                   data/stage/tracker-inbox.json (fit_good only)
                                                   │
                   plain-code sync (no LLM) ── sync-sheet ──> Google Sheet tracker
                                                   │
                            [future: cover-letter agent reads this, drafts letters]
```

---

## Pipeline architecture

`jobs.json` is a **master file that only ever grows and only ever moves
forward.** Nothing downstream is allowed to shrink it, duplicate it via an
LLM, or read every record to figure out what's already been handled. That
guarantee comes from one field on every job:

```typescript
pipelineStatus: 'scraped' | 'fit_good' | 'fit_bad' | 'tracked' | 'applied'
```

and one rule enforced in code (`src/core/pipeline-status.ts`), not by
convention: status can only move forward along this graph, never back.

```
scraped ──> fit_good ──> tracked ──> applied
   │
   └──> fit_bad   (terminal — dead end, on purpose)
```

`fit_bad` and `applied` are terminal. `canTransition()` refuses anything not
on this graph, `advanceStatus()` is the only way to change a job's status,
and `Store.updateStatus()` is the only entry point that calls it — a bad
transition returns `{ ok: false, reason }` instead of throwing or silently
succeeding. **Re-scraping a job you've already judged never resets it**:
`mergeJob()` in `dedupe.ts` deliberately never touches `pipelineStatus`,
`statusHistory` or `fitReason` on an existing record, so seeing the same
listing again on day 30 does not undo day 2's verdict.

This is what answers "how does an LLM avoid re-checking thousands of old
listings": it doesn't have to, because it never sees them. Each agent gets a
small, disposable, pre-filtered JSON file — built by plain TypeScript, zero
LLM tokens spent filtering — and that file *is* the filter:

| File | Built by | Contains | Read by |
|---|---|---|---|
| `data/jobs.json` | `run` | Every job ever seen, full metadata, permanent | You, `stats`, `export` |
| `data/stage/fit-filter-inbox.json` | `export-fit-inbox` | Only `pipelineStatus: 'scraped'`, open, within `fitInboxMaxAgeDays` | Fit-filter agent (future) |
| `data/stage/tracker-inbox.json` | `export-tracker-inbox` | Only `pipelineStatus: 'fit_good'` | `sync-sheet` (built, no LLM) + cover-letter agent (future) |

Both inbox files use the trimmed `CleanJob` shape, not the full `Job`
record — just `id`, `url`, `title`, `company`, `location`, `postedAt`,
`salary`, `tags`, `description`, and `fitReason` once set. No `raw`, no
`statusHistory`, no `fingerprint`, no `matchedQueries`. That's the "cleaner
data with only the essentials" you asked for — every field an LLM stage
would otherwise waste tokens skipping past is gone before the file reaches
it.

The full round trip, run manually until the two agents exist:

```powershell
# 1. Scrape as usual — master file grows, nothing is judged yet
npm run dev -- run --all

# 2. Build the small inbox for the fit-filter agent (zero LLM cost)
npm run export-fit-inbox

# 3. [future: fit-filter agent reads fit-filter-inbox.json, writes verdicts]
#    For now, write data/stage/fit-verdicts.json by hand to test the wiring:
#    [{ "id": "seek:94272826", "verdict": "good", "reason": "Java/Spring match" }]

# 4. Write those verdicts back into the master file (zero LLM cost, ratcheted)
npm run dev -- apply-fit-verdicts data/stage/fit-verdicts.json

# 5. Build the small inbox for the tracker stage — fit_good jobs only
npm run export-tracker-inbox

# 6. Sync those jobs into your Google Sheet tracker (zero LLM cost, ratcheted:
#    each synced job moves fit_good -> tracked so it's never re-sent).
#    One-time setup first: see docs/google-sheets-setup.md
npm run sync-sheet

# 7. [future: cover-letter agent reads tracker-inbox.json, drafts letters]

# 8. Pull "applied" back out of the Sheet and ratchet those jobs closed
npm run dev -- sync-applied data/stage/applied-from-sheet.json
```

**`sync-applied` is still a placeholder** — it's the read-back half (Sheet ->
`jobs.json`), not yet built. `sync-sheet` (see above) is the write half
(`jobs.json` -> Sheet) and is real: it uses the same Google Cloud project and
OAuth client as `sync-applied` eventually will (docs/google-sheets-setup.md).
Today, `sync-applied <file>` reads a local JSON array or a simple CSV
(columns `id` or `url`, optional `applied` boolean) and marks matching jobs
`applied`. When the real read-back is built, point it at the Sheets API using
`getAuthorizedClient()` from `src/core/google-sheets.ts`, or replace the
file-read in that command with an API call — `updateStatus()` and the ratchet
underneath it don't change.

If a job is marked `applied` in the Sheet directly (skipping `tracked`),
`mark-applied [ids...] [--from <file>]` sets it straight from any state to
`applied` without needing to pass through `tracked` first — the transition
graph allows both `fit_good ──> applied` and `tracked ──> applied` for
exactly this reason.

---

## Before you can run it

Three things. The first is required, the second is the one that decides whether
you get data, the third is optional.

### 1. Install dependencies

```powershell
cd C:\Users\madhi\Claude\Scraper
npm install
```

Node 20 or newer. `node -v` to check. No `node_modules` is committed, and there
are no native dependencies, so this is a clean install on Windows.

Verify the wiring before touching the network:

```powershell
npm test          # 73 tests, all offline, fixture-driven
npm run typecheck
```

### 2. Confirm the Seek search endpoint (already verified once, worth rechecking)

Seek's search API is private: it is what their own frontend calls, not
documented, and the path and parameter names can change without notice. The
endpoint shipped in `config/config.json` was confirmed working against a live
response on 2026-09-05 — that response is saved as
`test/fixtures/seek-search.real-2026-09-05.json` and is what the adapter's test
suite runs against, alongside the hand-built fixture. If Seek changes shape
after today, that test will fail and tell you exactly which field moved.

Treat it as unverified again after a few months, or the moment `npm run dev --
run --all` starts returning noticeably fewer or malformed jobs. To recheck it,
in Chrome:

1. Open <https://www.seek.com.au> and run a search you care about, for example
   "java spring boot" in "All Melbourne VIC".
2. F12 → **Network** tab → filter **Fetch/XHR**.
3. Click page 2 of the results so a fresh request fires.
4. Find the request whose response is JSON containing a `data` array of job
   objects. It is usually named `search`.
5. Right-click it → **Copy** → **Copy link address**.

Now compare it to `sources.seek` in `config/config.json`:

```json
"searchEndpoint": "https://www.seek.com.au/api/jobsearch/v5/search",
"siteKey": "AU-Main",
"sourcesystem": "houston",
"pageSize": 22,
"sortMode": "ListedDate"
```

- Different path (`/api/chalice-search/v4/search`, `v6`, something else)?
  Replace `searchEndpoint`.
- Extra query parameters in the real request that are not in the list above?
  Add them to `extraParams`.
- Different parameter *names* (`keywords`, `where`, `page`, `pageSize`)? Those
  are built in `src/adapters/seek.ts` → `searchUrl()`. Change them there.

Then confirm the shape end to end:

```powershell
npm run discover -- --source seek --query "java spring boot" --where "All Melbourne VIC"
```

That makes exactly one request, saves the full response to
`data/.cache/seek-sample.json`, and prints the top-level keys plus the field
names of `data[0]`. If it prints a list of keys including `id` and `title`, you
are done. If it prints "No data[] array found", the endpoint or its parameters
are wrong; open the saved file and adjust.

The mapper reads several candidate paths per field
(`advertiser.description`, then `advertiser.name`, then `companyName`, ...) so a
single field rename degrades one column instead of breaking the run. If Seek
renames something not in the candidate list, add it in `mapJob()` in
`src/adapters/seek.ts`.

### 3. Set your searches

Edit the `searches` array in `config/config.json`. It ships with three examples
aimed at Melbourne. `location` takes the string Seek itself uses, for example
`"All Melbourne VIC"`, `"Melbourne VIC 3000"`, `"All Australia"`.

### The `pipeline` config block

```json
"pipeline": {
  "fitInboxPath": "./data/stage/fit-filter-inbox.json",
  "trackerInboxPath": "./data/stage/tracker-inbox.json",
  "fitInboxMaxAgeDays": 14
}
```

- `fitInboxPath` / `trackerInboxPath` — where `export-fit-inbox` and
  `export-tracker-inbox` write. Override with `-o/--out` per invocation.
- `fitInboxMaxAgeDays` — a `scraped` job older than this is left out of the
  fit-filter inbox entirely, so the agent never spends tokens judging a
  stale listing. Override per run with `export-fit-inbox --max-age-days`.

---

## Using it

```powershell
# one ad-hoc search, print only, write nothing
npm run dev -- run --query "java spring boot" --where "All Melbourne VIC" --dry-run

# every enabled search in the config (fetches full descriptions by default — see below)
npm run dev -- run --all

# what is in the store
npm run dev -- stats

# export
npm run dev -- export --format csv --since 7d --out jobs.csv
npm run dev -- export --format json --tag java --tag junior
npm run dev -- export --source seek --open-only
```

Compiled use, which is what a scheduled task should call:

```powershell
npm run build
node dist/cli.js run --all
```

### Full descriptions and keyword tags

`config.json` ships with `defaults.fetchDetail: true`, so every new job gets a
second request to its Seek job page for the full description, extracted from
the page's embedded JSON-LD (`extractJobPostingLd` in `src/adapters/seek.ts`).
This is what lands in `description` on each record in `jobs.json`, in the
same form you'd read it on the site: bullet points as `- ` lines, headings on
their own lines, no HTML.

This adds one request per *new* job on top of the search pages —
already-seen jobs are never re-fetched. At the default 1.8-3.4s pacing, 75 new
jobs adds roughly 3-4 minutes to a run. Set `"fetchDetail": false` in
`config.json`'s `defaults` block if you'd rather scrape fast and add
descriptions later; the CLI still accepts a one-off override in either
direction with `--detail`.

**Tags without any LLM.** `normalize.ts`'s `extractTags()` runs a fixed
keyword list against the title and, once fetched, the description — `java`,
`spring`, `react`, `aws`, `microservices`, `rest`, `testing`, `agile`,
`junior`/`mid`/`senior` (read from the title only, so "mentored by senior
engineers" in a junior role's teaser doesn't mistag it), plus
`visa-sponsorship` and `citizen-only` flags. It is deliberately not an LLM:
the extraction is deterministic, free, and instant, and it is precisely the
kind of skill-matching keyword scan you'd otherwise ask a model to do less
reliably. Filter on it directly:

```powershell
npm run dev -- export --format json --tag java --tag spring
npm run dev -- export --format csv --tag react --tag typescript --since 3d
```

Add a keyword to `TAG_VOCAB` in `src/core/normalize.ts` any time you want to
track something new (a framework, a certification, a company you're
targeting) — it applies retroactively to already-scraped `raw` descriptions
next time you re-normalize, and to every job from then on.

### Commands

| Command | Purpose |
|---|---|
| `run` | Scrape and persist. `--all`, `--source`, `--query`/`--where`, `--max-pages`, `--max-age-days`, `--dry-run` |
| `stats` | Counts by source, open vs closed, salary coverage, top companies, pipeline-status breakdown |
| `export` | CSV or JSON, filtered by `--since`, `--source`, `--tag`, `--open-only`, `--status <status...>` |
| `discover` | One raw request, saved to `data/.cache/<source>-sample.json`, for when a source changes shape |
| `sources` | List registered adapters |
| `export-fit-inbox` | Build `data/stage/fit-filter-inbox.json` — `scraped`, open, within `--max-age-days` (default from config) |
| `apply-fit-verdicts <file>` | Write `[{id, verdict: 'good'\|'bad', reason?}]` back into the master file, ratcheted |
| `export-tracker-inbox` | Build `data/stage/tracker-inbox.json` (AU) and `data/stage/tracker-inbox-intl.json` (everything else, by `location.country`) — `fit_good` jobs only |
| `google-auth` | One-time interactive OAuth setup for Sheets access — see docs/google-sheets-setup.md |
| `sync-sheet [file]` | Append `fit_good` jobs to the Google Sheet tracker (deduped, no LLM), ratchet each to `tracked`, reconcile the Career Profile/Technical Skills/Cover Letter/Notes columns both ways, and pull back the Applied checkbox and Stages dropdown. `--intl` targets `pipeline.sheetsIntl` + the intl inbox file instead of the AU pair |
| `new-tracker-tab` | Rotate the tracker onto a fresh tab when the current one gets too big: duplicates it (keeping the Table's typed Applied/Stages columns and formatting), clears the data rows, and points `config.json`'s `pipeline.sheets.sheetName` at the new tab. `--intl` rotates `pipeline.sheetsIntl` instead |
| `export-profile-inbox` | Build `data/stage/profile-inbox.json` — `tracked` jobs with no career profile yet |
| `apply-career-profiles <file>` | Write the career-profile tailoring step's output (or a disqualifying/needs-clarification flag) into `jobs.json` |
| `export-coverletter-inbox` | Build `data/stage/cover-letter-inbox.json` — `tracked` jobs with a career profile but no cover letter yet |
| `apply-cover-letters <file>` | Write the cover-letter drafting step's output (or a needs-clarification flag) into `jobs.json` |
| `mark-applied [ids...]` | Set jobs straight to `applied`. `--from <file>` reads ids from JSON/CSV instead of the command line |
| `sync-applied <file>` | Placeholder for pulling "applied" back from a JSON/CSV export — superseded for the live Sheet by `sync-sheet`'s own Applied-checkbox pull-back, kept as a manual escape hatch |
| `replay <file>` | Re-run normalize+dedupe on a saved `RawJob` with no network call — for debugging the parser |

Global flags: `--config <path>` (default `./config/config.json`),
`--log-level debug|info|warn|error`.

`run` exits non-zero when any source was blocked, errored, or tripped the sanity
check, so a scheduled task shows a failure instead of quietly doing nothing.

---

## What lands on disk

```
data/
  jobs.json                    every job, keyed by id, written atomically
  runs/2026-09-05T08-00-00.json  per-run stats plus ids created and updated
  runs/index.json              rolling history, feeds the sanity check
  logs/scraper.log             JSON lines
  .cache/<sha1>.txt            raw responses
  stage/
    fit-filter-inbox.json      built by export-fit-inbox, small, disposable
    tracker-inbox.json         built by export-tracker-inbox, small, disposable
    fit-verdicts.json          you (or the future agent) write this, consumed by apply-fit-verdicts
    applied-from-sheet.json    you (or the future sync) write this, consumed by sync-applied
```

Everything under `data/stage/` is disposable output, safe to delete any
time — it's regenerated from `jobs.json` on the next `export-fit-inbox` /
`export-tracker-inbox` call and never the other way around.

**The cache is the most valuable directory here.** When a parser breaks because
Seek changed a field name, you fix the mapper and re-run against cached bytes
instead of hitting the site again and re-earning a rate limit. Default lifetime
is 6 hours (`cache.ttlMinutes`).

A job record carries `postedAt`, `scrapedAt`, `lastSeenAt`, `missedRuns` and
`closed`. A job missing from three consecutive runs is marked closed rather than
deleted, which is what makes "new since yesterday" trustworthy.

`raw` keeps the untouched source payload, so you can re-normalize historical
jobs after improving the parser without re-scraping anything.

---

## Design decisions worth knowing

**No LLM parsing.** Seek hands you structured JSON. Adding a model to that step
buys nothing and costs latency, money and determinism. The place a model does
earn its keep is pulling required years of experience out of free-text
descriptions, and only on jobs that already passed your filters.

**No Crawlee, no proxies, no Playwright yet.** A request queue, an autoscaler and
a proxy pool solve problems you do not have at one run a day from a Melbourne
residential IP. Playwright arrives with the Indeed adapter and not before.

**Seniority is read from the title only.** "Junior Frontend Developer, mentored
by senior engineers" is a junior role. Scoped tag matching is what stops that
kind of false positive.

**Missing salary is `undefined`, never zero.** Roughly 40% of AU listings hide
salary. Treating that as 0 poisons every average you later compute.

**Fingerprint keeps seniority, drops company noise.** "Acme Pty Ltd" and "Acme"
are one employer; "Senior Engineer" and "Engineer" are two different jobs.

**Rate limiting is the anti-blocking strategy.** Most blocks are earned by
request rate. One request per 1.8-3.4s per host, serialized, with backoff at
5s/15s/45s and a hard stop on the second 403 or 429.

---

## Debugging

Six configs are ready in `.vscode/launch.json` — open the Run and Debug
panel in VS Code, pick one, F5. All of them set breakpoints in your actual
`.ts` source (sourcemaps via `tsx`, no separate build step needed):

| Config | What it runs |
|---|---|
| Debug: run --all --dry-run | Full scrape, nothing written to disk — safe to breakpoint anywhere |
| Debug: run --all (writes to jobs.json) | Same, but persists — for debugging the store/dedupe path |
| Debug: replay a saved RawJob (no network) | Runs `replay` against a cached `RawJob` — for stepping through `normalize`/`dedupe` with zero network calls |
| Debug: apply-fit-verdicts | Steps through the ratchet write-back path |
| Debug: current Vitest file | Debugs whichever test file is open in the active editor |
| Attach to running process (port 9229) | Attaches to a process already started with `--inspect-brk` |

For the attach flow, or to debug the compiled CLI directly from a terminal
instead of VS Code's launch UI:

```powershell
npm run inspect -- run --all --dry-run
```

This starts Node paused with `--inspect-brk` on port 9229; either attach VS
Code's "Attach to running process" config, or open `chrome://inspect` in
Chrome and click "inspect" under Remote Target.

**`replay <file> [--query <label>] [--commit]`** is the fastest way to debug
a parsing or dedupe problem without hitting the network at all: save a raw
API response or job payload to a file (everything under `data/.cache/` is
already in this shape), then

```powershell
npm run dev -- replay data/.cache/seek-sample.json --query java-backend
```

runs it through `normalize` → `dedupe` exactly as a live run would and
prints the result, without touching the store — add `--commit` once you're
confident, to actually merge it into `jobs.json`.

---

## Scheduling on Windows

```powershell
npm run build
```

Task Scheduler → Create Basic Task:

- **Trigger:** Daily, 08:00
- **Action:** Start a program
- **Program:** `node`
- **Arguments:** `dist\cli.js run --all`
- **Start in:** `C:\Users\madhi\Claude\Scraper`

Tick "Run whether user is logged on or not" if you want it to fire on a locked
machine. Check `data/logs/scraper.log` after the first scheduled run: a task that
silently fails at 8am for a week is the normal way this goes wrong.

---

## Adding LinkedIn, Indeed or anything else

See `docs/adding-a-source.md`. Short version: copy `src/adapters/_template.ts`,
implement `search()` as an async generator yielding `RawJob`, register it in
`src/adapters/registry.ts`, add its settings to `config.json`. Cross-source
dedupe, normalization, storage and the CLI all start working for it immediately.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `page 1 returned no rows` | Endpoint or parameters changed | `npm run discover -- --source seek`, inspect `data/.cache/seek-sample.json` |
| `rows returned but none could be mapped` | Field names changed | Add the new paths to `mapJob()` in `src/adapters/seek.ts` |
| `Blocked by www.seek.com.au (HTTP 403)` | Rate, or headers rejected | Raise `minDelayMs`, confirm `userAgent` matches a current Chrome |
| `sanity check failed` | Got far fewer jobs than the last 3 runs | Usually the parser, occasionally a genuinely quiet day. Check the cache. |
| Same job appears twice | Company or title strings differ more than the normalizers handle | Add the pattern to `COMPANY_NOISE` / `TITLE_NOISE` in `src/core/dedupe.ts` |
| `Config not found` | No `config/config.json` | `copy config\config.example.json config\config.json` |

---

## Scope and conduct

Personal-use scraping at low volume. Keep it that way: one run a day, one
request at a time, no proxies, and do not redistribute what you collect.
Republishing scraped listings is a different activity with different rules, and
each site's terms would need reading first.

For LinkedIn specifically, when you get there: use the logged-out guest endpoint
only. Automating a signed-in session is what gets accounts restricted.
