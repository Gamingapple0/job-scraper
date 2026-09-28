# job-scraper

Local job scraper. Runs on your machine, writes to a JSON file, costs nothing.

Seek and LinkedIn are implemented. Indeed and anything else plug in behind a
single `SourceAdapter` interface without touching the pipeline, store or CLI
(Indeed is next, and needs Playwright — see "Design decisions" below).

This is a five-stage pipeline: scrape → an LLM agent judges fit against your
resume → good-fit roles get added to a Google Sheet tracker (a separate sheet
for AU vs. international roles) → an LLM agent writes a career profile and a
cover letter per job in one pass (from the resume version that job needs) →
resume and cover letter PDFs are built into one folder per company, inside a
timestamped batch folder → you apply, by hand or with the LinkedIn/SEEK apply skills. Everything in *this* repo is the deterministic,
zero-LLM plumbing that makes the agent stages cheap to run unattended on a
schedule: it decides what each agent is allowed to see, and no agent ever has
to read `jobs.json` itself to figure that out. Anshu's own manual tracking —
the Applied checkbox and the Stages dropdown (Take home / Initial Screen /
Final Round / Offer / NA / Invalid) — is read back by `sync-sheet` too: once
either is set on a row, that job stops being sent to any agent, full stop,
regardless of pipelineStatus. See "Pipeline architecture" below.

```
config/config.json ──> CLI ──> SourceAdapter (seek | linkedin) ──> RawJob
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
                     data/stage/tracker-inbox.json (AU) + tracker-inbox-intl.json
                                                   │
              plain-code sync (no LLM) ── sync-sheet [--intl] ──> Google Sheet tracker
                                                   │
                          master updated: pipelineStatus fit_good -> tracked
                                                   │
                           plain-code filter (no LLM) ── export-materials-inbox
                                                   │
                              data/stage/materials-inbox.json (small, disposable)
                                                   │
                  [materials agent: career profile + cover letter per job, one pass,
                   from the resume version the job classifies as]
                                                   │
                   plain-code write-back (no LLM) ── apply-materials
                   (checks resume_version + lint, stamps the version)
                                                   │
                     plain-code (no LLM) ── generate-documents
                                                   │
               Resumes Gen/<Batch timestamp>/<Company>/*.pdf + documents-index.json
                                                   │
                     plain-code filter (no LLM) ── export-apply-queue
                                                   │
                        [LinkedIn / SEEK apply skill submits, mark-applied]
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
| `data/stage/fit-filter-inbox.json` | `export-fit-inbox` | Only `pipelineStatus: 'scraped'`, open, within `fitInboxMaxAgeDays` | Fit-filter agent |
| `data/stage/tracker-inbox.json` + `tracker-inbox-intl.json` | `export-tracker-inbox` | Only `pipelineStatus: 'fit_good'`, split AU vs. everything else by `location.country` | `sync-sheet` (built, no LLM) |
| `data/stage/profile-inbox.json` | `export-profile-inbox` | Only `tracked` jobs with no career profile yet | Career-profile agent |
| `data/stage/cover-letter-inbox.json` | `export-coverletter-inbox` | Only `tracked` jobs with a current career profile but no current cover letter | Cover-letter agent (single-stage variant) |
| `data/stage/materials-inbox.json` | `export-materials-inbox` | Union of the two above: `tracked` jobs still needing a profile, a letter, or both, with the resume file to use | Materials agent (the normal path) |
| `data/stage/apply-queue.json` | `export-apply-queue` | Jobs ready to submit on LinkedIn / SEEK, with tailored text and exact PDF paths | Apply skills |

The fit-filter and tracker inboxes use the trimmed `CleanJob` shape, not the
full `Job` record — just `id`, `url`, `title`, `company`, `location`,
`postedAt`, `salary`, `tags`, `description`, and `fitReason` once set. No
`raw`, no `statusHistory`, no `fingerprint`, no `matchedQueries`. The
profile and cover-letter inboxes trim even further (`ProfileJob` /
`CoverLetterJob` in `src/core/stage-export.ts`): just `id`, `url`, `title`,
`company`, `description`, which base resume to tailor from
(`resumeVersion`), and any unresolved clarification note from a previous
run — no tags, no salary, no fitReason, since those stages never use them.
That's the "cleaner data with only the essentials" you asked for — every
field an LLM stage would otherwise waste tokens skipping past is gone
before the file reaches it.

The full round trip, in the order a scheduled run actually does it:

```powershell
# 1. Scrape as usual — master file grows, nothing is judged yet
npm run dev -- run --all

# 2. Build the small inbox for the fit-filter agent (zero LLM cost)
npm run export-fit-inbox

# 3. Fit-filter agent reads fit-filter-inbox.json, writes verdicts to
#    data/stage/fit-verdicts.json:
#    [{ "id": "seek:94272826", "verdict": "good", "reason": "Java/Spring match" }]

# 4. Write those verdicts back into the master file (zero LLM cost, ratcheted)
npm run dev -- apply-fit-verdicts data/stage/fit-verdicts.json

# 5. Build the small inboxes for the tracker stage — fit_good jobs only,
#    split AU vs. everything else
npm run export-tracker-inbox

# 6. Sync those jobs into your Google Sheet tracker(s) (zero LLM cost,
#    ratcheted: each synced job moves fit_good -> tracked so it's never
#    re-sent). Syncs both the AU and international sheets by default.
#    One-time setup first: see docs/google-sheets-setup.md
npm run sync-sheet

# 7. Career profile + cover letter, written together in one pass. The
#    inbox holds every tracked job that still needs either piece: missing,
#    or written from a different resume version than the job classifies as
#    now ("drifted", see "Which resume a job uses" below). One record per
#    job, the JD once, which base resume file to use, and what is needed.
npm run dev -- export-materials-inbox

# 8. The agent follows Claude outputs/application-materials-prompt.md and
#    writes data/stage/materials-verdicts.json, one entry per job:
#    { id, resume_version, career_profile?, cover_letter? } or an error.
#    Write it back. Every entry is checked in code first: resume_version
#    must equal the job's own classification, and each text passes the
#    lint (em dash, word count, placeholders, salutation, company named).
#    Rejected entries are listed with reasons, exit code 3, nothing else
#    is affected. --dry-run validates without writing.
npm run dev -- apply-materials data/stage/materials-verdicts.json

#    (The single-stage commands still exist with the same guards:
#    export-profile-inbox / apply-career-profiles and
#    export-coverletter-inbox / apply-cover-letters. Their verdicts now
#    need a resume_version on every entry.)

# 9. sync-sheet (step 6) already pulls "applied" back from the live Sheet
#    on every run. sync-applied is the manual fallback for a plain
#    JSON/CSV export instead:
npm run dev -- sync-applied data/stage/applied-from-sheet.json

# 10. Build the application documents. Every unapplied tracked job with a
#     current career profile and cover letter gets a resume PDF (the base
#     Google Doc for ITS resume version, Career Profile swapped in) and a
#     cover letter PDF, into a folder named after the company. New or
#     changed jobs only; --force rebuilds everything. Zero LLM cost.
npm run generate-documents
```

**Step 10 (`generate-documents`)** needs `python3` (with `python-docx`),
LibreOffice (`soffice`) and `pdfinfo` (poppler-utils) on PATH, see
`scripts/generate_documents.py`. The two base resumes are Google Docs (ids
in `pipeline.documentsResumeDocs`, shared "Anyone with the link can view"):
Anshu edits Employment/Education/Technical Skills there directly; the
script only ever rewrites the Career Profile and Technical Skills content
paragraphs. Education and Employment are never touched, including by the
page-fit condensation described below.

**Where the files go.** One folder per company, inside a timestamped batch
folder, under `pipeline.documentsOutputDir` (override with the
`SCRAPER_DOCS_OUTPUT_DIR` environment variable, needed inside the Claude
Cowork device_bash sandbox where the connected folder is mounted elsewhere
than its real Windows path). A company that already has a folder in the
batch (same company ignoring case and legal suffixes, so "Atlassian Pty
Ltd" goes into `Atlassian`) gets the new files added to it, so several roles
at one company sit together:

```
Resumes Gen/
  2026-09-20-06-21-16/
    documents-index.json
    Synechron/
      Anshu_Madhikarmi_Synechron_API_Automation_Tester_Resume.pdf
      Anshu_Madhikarmi_Synechron_API_Automation_Tester_Cover_Letter.pdf
      Anshu_Madhikarmi_Synechron_Software_Engineer_Resume.pdf
      Anshu_Madhikarmi_Synechron_Software_Engineer_Cover_Letter.pdf
    Akkodis/
      ...
```

**Every run of `generate-documents` starts a brand-new batch folder** —
named `YYYY-MM-DD-HH-MM-SS` for when that run started — rather than growing
the last one forever. Only jobs still eligible for documents (still open:
not applied, not closed, no interview-stage outcome recorded) make it into
the new batch:

- A job whose profile/letter/resume version haven't changed since the
  previous batch has its existing PDFs **copied across** from there, no
  rebuild needed.
- A new or changed job is built fresh into the new batch, same as always.
- A job that dropped out (applied, closed, or an interview stage got
  recorded) is **not** copied forward — its folder is simply left behind in
  the previous batch.

That last point is what keeps the current batch from growing without
bound: it only ever holds what's still pending, never an ever-larger pile
of companies Anshu has already applied to. Nothing is ever deleted —
previous batches sit untouched under `documentsOutputDir` for as long as
Anshu wants to keep them (his existing `_to_delete/` folder is where he
moves ones he's done with).

Only new or changed jobs are actually rebuilt on each run:
`documents-index.json` (in the batch folder) maps every job id to its
folder, file names and a hash of the inputs (profile, letter, resume
version, base doc, relocation note). A job whose hash and files are
unchanged since the previous batch is copied across rather than rebuilt, and
`--force` rebuilds everything instead, which is what to use after editing a
base resume Google Doc (an edit there is not visible to the hash). If a
second job at the same company would produce the same file name, it gets a
short job-id suffix instead of overwriting the first. The index also holds
the real Windows path to the batch folder and is what the apply skills read
to find the exact PDFs for a job id; `export-apply-queue` always reads
whichever batch was written to most recently. Folders from the pre-refactor
timestamped layout (flat PDFs, or an AU/International split, no
`documents-index.json`) are left alone — they never count as a batch and so
are never picked up, migrated from, or written to.

An international job (`job.location.country !== 'AU'`, see `isInternational`
on `DocumentJob` in `src/core/stage-export.ts`) also gets its resume phone
number and cover letter contact line switched from the local `0406973781`
format to `+61 406 973 781` (a domestic number doesn't dial from overseas;
`set_international_phone`/`contact_line` in `scripts/generate_documents.py`
only edit the plain run carrying the digits, so the LinkedIn/Portfolio
hyperlinks on the same line are untouched), and the resume headline gets a
further `| PTE: 88` appended after the relocation note.

Filenames follow `Anshu_Madhikarmi_<Company>_<Role>_Resume.pdf` /
`..._Cover_Letter.pdf` — company first so a folder of 29 of these sorts by
employer, not by document type — and are capped at `MAX_FILENAME_LENGTH`
(75 characters, see `src/core/stage-export.ts`). Company and role text
both go through `sanitizeFilenamePart`, which replaces every run of
non-alphanumeric characters — spaces, commas, slashes, parentheses,
ampersands, dashes, anything Windows won't allow or that just clutters a
name — with a single underscore, so "AT&T" becomes `AT_T`, "Xero -
Payments" becomes `Xero_Payments`, and "Full Stack Developer (Java/React)"
becomes `Full_Stack_Developer_Java_React`. Company names get acronymed
instead of spelled out once they're long or many-worded (see
`isWeirdCompanyName` in `src/core/stage-export.ts`). A job title that's
long or loaded with classification tags — e.g. "Assoc Delivery Cons -
App/Dev, Associate to Consultant (A2C) ProServe Shared Delivery (SDT)" — is
shortened to just its first clause (`Assoc_Delivery_Cons`) instead of
spelling the whole thing out; a title with no natural break that's still
too long is hard-truncated at a word boundary. The resume and its cover
letter always get the identical (shortened or not) title text, just a
different suffix. The name line on the resume gets
" | Open to relocation to \<X\>" appended whenever the job isn't Melbourne,
VIC — X is the AU state code for another Australian state, or the full
country name outside Australia (see `relocationNote` in the same file);
nothing is added for Melbourne/VIC jobs. Every run of `python3` forces
Calibri explicitly on ascii/hAnsi/eastAsia/cs for any run it writes (name
line, relocation note, Career Profile, Technical Skills, the whole cover
letter) — python-docx's `font.name =` only sets ascii/hAnsi, and leaving
eastAsia/cs unset was what caused the relocation note to render in a
mismatched fallback font.

Technical Skills is never trimmed for length — every skill in the base
Google Doc appears on every resume. The one edit `dedupe_technical_skills()`
makes is dropping an exact case-insensitive repeat (the base template's
own Technical Skills line has "JavaScript" twice, a copy-paste artifact,
not something worth keeping); it never shortens the list or drops a
distinct skill.

Both documents are held to one page. LibreOffice renders the base template
at two pages even though it's one page in Google Docs (font-substitution
metrics, not a content problem), so after building each resume the script
converts it, checks the PDF's page count via `pdfinfo`, and — never
touching font size, Technical Skills, or Education/Employment — first
nudges the top/bottom margins in (0.15in to start, then by 0.05in per
retry, floored at 0.35in total reduction: `MARGIN_START_IN`/`MARGIN_STEP_IN`/
`MARGIN_MAX_IN` in `scripts/generate_documents.py`). Reclaiming margin
space is enough on its own for the real job set (validated against 29 real
career profiles with full untrimmed skills lists: one margin step fit
28/29, two fit the last one). Only once margins hit that floor and the
resume still overflows does it fall back to condensing the Career Profile
(drops trailing sentences, floored at 2 sentences) — a last resort, not
the normal path. The cover letter has no condensation lever (its body is
already-drafted upstream, out of scope for this zero-LLM-cost stage to
rewrite) and carries no date line (Anshu may reuse a letter later, so a
stale date would be wrong); it stays to one page because the layout uses a
single explicit per-paragraph space-after instead of blank spacer
paragraphs stacked on top of the style's own spacing, which was the actual
source of the excess whitespace. The header block lists phone+email,
LinkedIn, and Anshu's portfolio (https://anshumadhikarmi.netlify.app/)
each on their own line — folding them onto one long line let the LinkedIn
URL wrap unpredictably at the cover letter's text width. Every fit-check
render happens in a local scratch directory — the OneDrive-mounted output
folder is written to exactly once per finished PDF. The first version
rendered every attempt straight into the mounted folder, which was both
much slower (each write seems to go through OneDrive's sync watcher) and
the source of stray `.~lock.*#` and `*.tmp` files LibreOffice left behind
there.

At 29 jobs a full run currently takes well under 2 minutes — margin
reduction usually converges in one or two LibreOffice conversions per job,
much faster than the career-profile condensation fallback would. A
scheduled task invoking this via `device_bash` should still pass a
generous `timeout_ms` for this step and expect to need a larger cap as the
number of unapplied tracked jobs grows.

**`sync-sheet` already reads the Sheet back, live** — every run calls
`reconcileSheetColumns()` (`src/core/google-sheets.ts`) over the Sheets API,
which pulls the Applied checkbox and Stages dropdown (plus any Career
Profile/Cover Letter cell Anshu edited by hand) straight back into
`jobs.json`, no export needed. `sync-applied <file>` is a separate, manual
escape hatch for the rarer case of a plain local JSON array or CSV (columns
`id` or `url`, optional `applied` boolean) — useful for a one-off import,
not part of the normal scheduled run.

If a job is marked `applied` in the Sheet directly (skipping `tracked`),
`mark-applied [ids...] [--from <file>]` sets it straight from any state to
`applied` without needing to pass through `tracked` first — the transition
graph allows both `fit_good ──> applied` and `tracked ──> applied` for
exactly this reason.

---

## Which resume a job uses

There are two base resumes: software-engineer and test-analyst (a Google Doc
each, `pipeline.documentsResumeDocs`, plus a markdown copy the LLM steps read:
`Claude outputs/resume.md` and `Claude outputs/resume-test-analyst.md`). Which
one a job gets is decided in exactly one place, `classifyResumeVersion` in
`src/core/resume-version.ts`, and every stage uses it: the inboxes tell the
agent which markdown to read, the intake checks the agent used it, and the
documents stage picks the Google Doc from it.

- A title naming a testing role (QA, tester, test analyst, test engineer, SDET,
  test automation, quality engineer, software engineer in test) is test-analyst.
- A title that only says "automation" is decided by the JD: at least 4 testing
  terms (test automation, Playwright, Selenium, regression, UAT and so on) and
  clearly more of them than RPA/workflow/DevOps terms is test-analyst.
  Everything else is software-engineer.
- Every accepted profile and letter is stamped with the version it was written
  from (`careerProfileVersion`, `coverLetterVersion` on the job). If the stamp
  ever disagrees with the job's current classification the text is "drifted":
  it counts as missing, the materials inbox re-queues it, and
  `generate-documents` refuses to build with it. An unstamped profile predates
  stamping and counts as software-engineer, since that was the only base then.
  This is how a software-engineer profile ended up in a test-analyst
  application before: the documents stage used a title-only regex that missed
  "API Automation Tester", while the agents were always handed the
  software-engineer resume. Nothing compared the two.
- A profile Anshu types into the Sheet is his: it is stamped as current and
  never re-queued.
- To add a third resume, add the version to `ResumeVersion` and the two maps in
  `resume-version.ts`, a Google Doc id to `documentsResumeDocs` in `config.ts`,
  a markdown copy under `Claude outputs/`, and a rule to `classifyResumeVersion`.
  The tests in `test/resume-version.test.ts` pin the current rules.

**Regenerated text and the Sheet.** `sync-sheet` treats a non-empty Career
Profile / Cover Letter cell as Anshu's edit and pulls it back, except when the
cell still holds exactly what the sync last saw there (`sheetCareerProfile` /
`sheetCoverLetter` on the job): then jobs.json was regenerated and the cell is
stale, so the new text is pushed. Run `sync-sheet` before exporting the
materials inbox so that snapshot exists.

## Applying with the skills

`export-apply-queue` builds `data/stage/apply-queue.json` from jobs.json and
`documents-index.json`, so the LinkedIn/SEEK apply skills start from a short
JSON list (already split by platform, with the exact PDF paths) and never have
to read the Google Sheet through a browser. After a submit the skill runs
`mark-applied <id> --note "Applied by llm"`; the next `sync-sheet` ticks the
Applied checkbox in the Sheet for it (if the Table's typed checkbox column
refuses the write, that is logged as a warning and the job is still applied in
jobs.json). `apply-note <id> <text>` records a blocker (an unanswered screening
question, external-only apply); such a job leaves the queue until the note is
cleared (`apply-note <id> x --clear`) or the queue is built with `--retry`.

**Skipping external-apply jobs before they ever cost a browser visit.** A job
carries `applyMethod` (`quick_apply` / `easy_apply` / `external`) once it's
known. Seek jobs get this for free at scrape time — the detail page Seek
already fetches for the description also carries `"isLinkOut":true|false` in
its embedded page state (true means applying redirects off Seek to the
employer's own site; false means it stays on Seek as "Quick apply") — see
`extractApplyMethod` in `src/adapters/seek.ts`. LinkedIn never exposes Easy
Apply eligibility to a logged-out request (checked against the guest search
cards, the guest detail endpoint and the full public job page — none carry
it), so a LinkedIn job's `applyMethod` starts unset and is only ever written
by the apply skill itself, live, via `set-apply-method <id> easy_apply|
external` the first time it actually opens the listing. Either way, once a
job's `applyMethod` is `external`, `export-apply-queue` records the
`External apply only` apply-note for it automatically, before the apply
skill ever sees it — no LLM judgement and no browser navigation spent
confirming what's already known.

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
npm test          # 101 tests, all offline, fixture-driven
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

Edit the `searches` array in `config/config.json` — it ships with the real
38-search set this repo runs (Melbourne/Sydney/Brisbane/Perth/AU-remote,
plus 491-eligible regional AU: Canberra, Adelaide, Newcastle, Wollongong,
Geelong, Gold Coast, Ballarat, Sunshine Coast; plus NZ, Ireland, UK, Germany,
Netherlands, Canada, Singapore, UAE, and regional international tech hubs
(Halifax, Waterloo, Cork, Manchester)), each tagged with which `sources`
(`seek`, `linkedin`, or both) to use.
`config/config.example.json` has a minimal 3-search starting point instead,
if you'd rather trim it down for your own search. `location` takes the
string each source itself uses — for Seek, e.g. `"All Melbourne VIC"`,
`"Melbourne VIC 3000"`, `"All Australia"`; for LinkedIn, a plain place name
like `"New Zealand"` or `"Germany"`.

Your real Google Sheet tracker IDs live in `config/config.local.json`
(gitignored, not `config/config.json`) — see docs/google-sheets-setup.md.

### The `pipeline` config block

```json
"pipeline": {
  "fitInboxPath": "./data/stage/fit-filter-inbox.json",
  "trackerInboxPath": "./data/stage/tracker-inbox.json",
  "trackerInboxIntlPath": "./data/stage/tracker-inbox-intl.json",
  "profileInboxPath": "./data/stage/profile-inbox.json",
  "coverLetterInboxPath": "./data/stage/cover-letter-inbox.json",
  "materialsInboxPath": "./data/stage/materials-inbox.json",
  "applyQueuePath": "./data/stage/apply-queue.json",
  "fitInboxMaxAgeDays": 14,
  "sheets": { "spreadsheetId": "", "sheetName": "Tracker" },
  "sheetsIntl": { "spreadsheetId": "", "sheetName": "Tracker" }
}
```

- `fitInboxPath` / `trackerInboxPath` / `trackerInboxIntlPath` /
  `profileInboxPath` / `coverLetterInboxPath` — where each `export-*`
  command writes. Override with `-o/--out` per invocation (`sync-sheet`'s
  positional `[file]` argument overrides the tracker path the same way).
- `fitInboxMaxAgeDays` — a `scraped` job older than this is left out of the
  fit-filter inbox entirely, so the agent never spends tokens judging a
  stale listing. Override per run with `export-fit-inbox --max-age-days`.
- `sheets` / `sheetsIntl` — the AU and international Google Sheet targets.
  `spreadsheetId` is intentionally blank in the committed `config.json`;
  the real ones belong in `config/config.local.json` instead (gitignored —
  see docs/google-sheets-setup.md).

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
second request to its detail page for the full description. Each adapter
extracts it its own way, reading what a real user actually sees first and
falling back rather than guessing: Seek reads the visible
`data-automation="jobAdDetails"` block first, then its embedded JSON-LD,
then its Next.js page state (`src/adapters/seek.ts`); LinkedIn reads the
visible description body first, falling back to its embedded JSON posting
(`src/adapters/linkedin.ts`). Either way, this is what lands in
`description` on each record in `jobs.json`, in the same form you'd read it
on the site: bullet points as `- ` lines, headings on their own lines, no
HTML.

This adds one request per *new* job on top of the search pages —
already-seen jobs are never re-fetched. Pacing is per source (Seek
~1.8-3.4s, LinkedIn ~3-5s — see below), so 75 new jobs adds a few minutes
to a run. Set `"fetchDetail": false` in `config.json`'s `defaults` block if
you'd rather scrape fast and add descriptions later; the CLI still accepts
a one-off override in either direction with `--detail`.

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
| `sync-sheet [file]` | Append `fit_good` jobs to the Google Sheet tracker (deduped, no LLM), ratchet each to `tracked`, reconcile the Career Profile/Cover Letter/Notes columns both ways, and pull back the Applied checkbox and Stages dropdown. By default syncs both the AU sheet and the international one; `--intl` syncs only the international pair |
| `new-tracker-tab` | Rotate the tracker onto a fresh tab when the current one gets too big: duplicates it (keeping the Table's typed Applied/Stages columns and formatting), clears the data rows, and points `config.json`'s `pipeline.sheets.sheetName` at the new tab. By default rotates both the AU and international tabs; `--intl` rotates only the international one |
| `export-profile-inbox` | Build `data/stage/profile-inbox.json` — `tracked` jobs with no career profile yet |
| `apply-career-profiles <file>` | Write the career-profile tailoring step's output (or a disqualifying/needs-clarification flag) into `jobs.json` |
| `export-coverletter-inbox` | Build `data/stage/cover-letter-inbox.json` — `tracked` jobs with a career profile but no cover letter yet |
| `apply-cover-letters <file>` | Write the cover-letter drafting step's output (or a needs-clarification flag) into `jobs.json` |
| `export-materials-inbox` | Build `data/stage/materials-inbox.json`: `tracked` jobs that still need a career profile, a cover letter, or both (missing, or written from a different resume version than the job classifies as now) |
| `apply-materials <file>` | Write the combined step's output into `jobs.json`: `{id, resume_version, career_profile?, cover_letter?}` or an error entry. Rejects a wrong `resume_version` and anything failing the lint; exit code 3 lists the rejected entries. `--dry-run` validates only |
| `generate-documents` | Zero-LLM-cost: for every unapplied `tracked` job with a current career profile and cover letter, swap the profile into the base resume Google Doc for its resume version, build a cover letter, export both as PDFs into `pipeline.documentsOutputDir`/`<Batch timestamp>/<Company>/`. Every run starts a fresh batch folder; a still-open job unchanged since the previous batch has its PDFs copied across instead of rebuilt, and an applied/closed job is simply left out (so the batch never grows to include jobs already applied to). Only new or changed jobs are rebuilt; `--force` rebuilds all. Writes `documents-index.json` in the batch folder. International jobs also get a `+61`-formatted phone and a `PTE: 88` headline addition. Needs `python3`+`python-docx` and `soffice` on PATH |
| `export-apply-queue` | Build `data/stage/apply-queue.json`: LinkedIn and SEEK jobs ready to submit, with tailored text and PDF paths. First auto-records an `External apply only` apply-note for any job already known to be `applyMethod: external`, so those never reach the apply skill. `--retry` includes jobs carrying an apply note |
| `apply-note <id> <text...>` | Record why a job could not be submitted; it leaves the apply queue. `--clear` removes the note |
| `set-apply-method <id> <method>` | Record how a LinkedIn job is applied to (`easy_apply` \| `quick_apply` \| `external`), once the apply skill has actually seen the listing. Seek never needs this — it's tagged for free at scrape time |
| `mark-applied [ids...]` | Set jobs straight to `applied`. `--from <file>` reads ids from JSON/CSV instead of the command line. `--note <text>` records an apply note, which `sync-sheet` uses to tick the Applied checkbox and fill Notes |
| `sync-applied <file>` | Manual fallback for pulling "applied" back from a JSON/CSV export — `sync-sheet` already pulls this live from the Sheet on every run; use this only for a one-off file-based import |
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
    tracker-inbox.json         built by export-tracker-inbox (AU), small, disposable
    tracker-inbox-intl.json    built by export-tracker-inbox (everything else), small, disposable
    profile-inbox.json         built by export-profile-inbox, small, disposable
    cover-letter-inbox.json    built by export-coverletter-inbox, small, disposable
    materials-inbox.json       built by export-materials-inbox, small, disposable
    materials-verdicts.json    the materials agent writes this, consumed by apply-materials
    apply-queue.json           built by export-apply-queue, small, disposable
    fit-verdicts.json          the fit-filter agent writes this, consumed by apply-fit-verdicts
    profile-verdicts.json      the career-profile agent writes this, consumed by apply-career-profiles
    coverletter-verdicts.json  the cover-letter agent writes this, consumed by apply-cover-letters
    applied-from-sheet.json    you write this by hand, consumed by sync-applied (manual escape hatch)
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
request rate. One request at a time per host, serialized, paced per source
(Seek ~1.8-3.4s, LinkedIn ~3-5s — it blocks harder), with backoff at
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

## Adding Indeed or another source

Seek and LinkedIn are already implemented and are the two real examples to
copy from — LinkedIn in particular shows how to work with a guest/public
endpoint that doesn't hand back a clean JSON API the way Seek's does. See
`docs/adding-a-source.md`. Short version: copy `src/adapters/_template.ts`
(or start from `seek.ts`/`linkedin.ts`), implement `search()` as an async
generator yielding `RawJob`, register it in `src/adapters/registry.ts`, add
its settings to `config.json`. Cross-source dedupe, normalization, storage
and the CLI all start working for it immediately. Indeed specifically needs
Playwright (see "Design decisions" above), since it doesn't expose a usable
guest API the way Seek and LinkedIn do.

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

For LinkedIn specifically: the adapter already only uses the logged-out guest
endpoint (`jobs-guest/...`), never a signed-in session — automating a
signed-in session is what gets accounts restricted, so keep it that way if
you touch `src/adapters/linkedin.ts`.
