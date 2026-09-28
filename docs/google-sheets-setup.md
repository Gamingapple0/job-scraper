# Google Sheets setup (Stage 3: sync-sheet)

One-time setup so `sync-sheet` can write to your tracker Sheet without any LLM involvement and without further interaction after today. This uses OAuth (your own Google account), not a service account — you'll approve access once in a browser, and the app then refreshes its own access token forever.

Set your tracker Sheet's ID as `pipeline.sheets.spreadsheetId` in
`config/config.local.json` (gitignored — copy `config/config.local.json.example`
to start). `config/config.json` ships with this field blank on purpose, since
a spreadsheet ID is specific to you, not something a public repo should carry.

## 1. Create a Google Cloud project

1. Go to https://console.cloud.google.com/projectcreate
2. Name it something like `job-scraper` and click **Create**.
3. Make sure the new project is selected (top-left project switcher).

## 2. Enable the Google Sheets API

1. Go to https://console.cloud.google.com/apis/library/sheets.googleapis.com
2. Confirm the right project is selected, then click **Enable**.

## 3. Configure the OAuth consent screen

1. Go to https://console.cloud.google.com/apis/credentials/consent
2. Choose **External** (unless you have a Google Workspace org and want Internal) and click **Create**.
3. Fill in the required fields (app name e.g. "Job Scraper", your email for support and developer contact). Click through **Save and Continue** on Scopes and Test users — you don't need to add scopes here.
4. On the summary page, click **Back to Dashboard**. The app will stay in "Testing" mode, which is fine — that just means only test users you add can authorize it.
5. Under **Test users**, add the Google account you'll use to edit the Sheet (your own Gmail address).

## 4. Create an OAuth client ID

1. Go to https://console.cloud.google.com/apis/credentials
2. Click **Create Credentials → OAuth client ID**.
3. Application type: **Desktop app**. Name it e.g. "job-scraper-cli".
4. Click **Create**, then **Download JSON** on the resulting credential.
5. Save that file as:
   ```
   config/google-oauth-client.json
   ```
   in this repo. This file is already gitignored — never commit it.

## 5. Authorize once

From the repo root:

```
npm run google-auth
```

This prints a Google consent URL. Open it in a browser, sign in with the account you added as a test user, and approve access. The command captures the redirect locally and saves a refresh token to `config/google-oauth-token.json` (also gitignored). You only need to do this once — `sync-sheet` reuses and refreshes that token on every run after.

If you ever revoke access (https://myaccount.google.com/permissions) or delete the token file, just re-run `npm run google-auth`.

## 6. Run the sync

```
npm run export-tracker-inbox
npm run sync-sheet
```

`sync-sheet` reads `data/stage/tracker-inbox.json` by default (or pass a path: `npm run sync-sheet -- path/to/file.json`), creates the `Tracker` tab and header row on first run if the sheet is empty, appends one row per job not already present (matched by Job ID in column A — no duplicates even if you re-run it), and advances each synced job's `pipelineStatus` to `tracked` in `data/jobs.json` so `export-tracker-inbox` never re-sends it. Nothing here calls an LLM.

## Columns written

Written in this order (`sheetHeaders()` in `src/core/google-sheets.ts`):

| Column | Source |
| --- | --- |
| Job ID | `CleanJob.id` (stable, matches `data/jobs.json`) |
| Title | `CleanJob.title` |
| Company | `CleanJob.company` |
| Location | `CleanJob.location` |
| Country | `CleanJob.country` — international tracker only (`pipeline.sheetsIntl.includeCountry`); every AU job is AU, so the AU tracker doesn't carry this column |
| URL | `CleanJob.url` |
| Applied/Closed | left blank — Anshu's own checkbox, filled in by hand |
| Career Profile | `Job.careerProfile` — see "Stage 3b: career profile" below |
| Cover Letter | `Job.coverLetter` |
| Fit Reason | `CleanJob.fitReason` (from the Stage 2 fit-filter agent) |
| Date Added | today's date, when the row was written |
| Date Posted | `CleanJob.postedAt` |
| Tags | `CleanJob.tags`, comma-joined |
| Salary | `CleanJob.salary` |
| Notes | flag for a job the career-profile step couldn't finish — a disqualifying requirement it spotted, or an unanswered clarifying question |
| Stages | Anshu's own dropdown, filled in by hand |

Want different columns, a different tab name, or a different spreadsheet? Edit `pipeline.sheets` / `pipeline.sheetsIntl` in `config/config.local.json` (`spreadsheetId`) or `config/config.json` (`sheetName`, `includeCountry`) or `sheetHeaders()` / `jobToRow()` in `src/core/google-sheets.ts`.

## Stage 3b: career profile (no LLM in the plumbing, LLM only for the writing itself)

Once a job is `tracked`, a separate stage tailors a `career_profile` paragraph for it, using the exact prompt in `Claude outputs/career-profile-tailoring-prompt.md`. The LLM's only job is: read the base resume + this job's JD + the company name, and produce that one field — everything else here is plain deterministic code, same philosophy as the fit-filter stage.

```
npm run build
node dist/cli.js export-tracker-inbox      # refresh, cheap, always safe
node dist/cli.js sync-sheet                # push any newly fit_good jobs; pulls back manual sheet edits
node dist/cli.js export-profile-inbox      # -> data/stage/profile-inbox.json: tracked jobs missing a career profile
# [LLM step: apply career-profile-tailoring-prompt.md to each job in that file,
#  write results to a verdicts file — see the prompt's "Orchestration notes"]
node dist/cli.js apply-career-profiles data/stage/profile-verdicts.json
node dist/cli.js sync-sheet                # push the newly-written profiles into the sheet
```

Two things make this safe to run nightly without re-spending tokens or losing track of anything:

- **Once a job has a `careerProfile`, `export-profile-inbox` never selects it again** — whether that value came from the LLM step or from Anshu typing straight into the Sheet's Career Profile column. `sync-sheet` reconciles both directions every time it runs: a non-empty Sheet cell always wins and gets pulled back into `jobs.json`; otherwise whatever `jobs.json` has gets pushed into the Sheet. No separate "already applied this edit" bookkeeping needed.
- **A job the LLM couldn't finish (`disqualifying_requirement` or `needs_clarification`) gets a note in the Sheet's Notes column, not silence.** It's retried every run (cheap) until either `Claude outputs/tailoring-clarifications.md` answers the question or Anshu writes the profile himself. It's never dropped from the tracker, and Stage 2 / `export-tracker-inbox` don't know or care that it's flagged — `pipelineStatus` is untouched by any of this.

See `Claude outputs/career-profile-tailoring-prompt.md` for the prompt itself and how it's meant to be applied, and `Claude outputs/tailoring-clarifications.md` for the running log of answers that keeps it from re-asking the same question.

## Adding this to the nightly scheduled task

Not wired in yet by default. Once you're happy with a manual run, add these two lines after `export-tracker-inbox` in the same scheduled task Stage 2 uses (trigger `trig_01APtpPsrcq515eGJd5qc7Fq`):

```
npm run export-tracker-inbox
npm run sync-sheet                          # syncs both the AU and international sheets
```

Both are plain deterministic commands with exit codes — no LLM step, no extra token cost, consistent with how the rest of that task is built.
