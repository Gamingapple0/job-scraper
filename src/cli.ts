#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig, type Config, type SearchConfig } from './core/config.js';
import { Logger, type LogLevel } from './core/logger.js';
import { RateLimiter } from './core/rate-limit.js';
import { ResponseCache } from './core/cache.js';
import { HttpClient } from './core/http.js';
import { JsonStore } from './core/store.js';
import { runSearch } from './core/pipeline.js';
import { createAdapter, availableSources, hasAdapter } from './adapters/registry.js';
import type { Job, PipelineStatus, RawJob, RunOptions, RunStats, SearchQuery } from './core/types.js';
import { toCsv, parseDuration, formatLocation, formatSalary } from './core/export.js';
import { toCleanJob, selectForStage, toProfileJob, toCoverLetterJob, type CleanJob } from './core/stage-export.js';
import {
  getAuthorizedClient,
  runInteractiveAuth,
  syncJobsToSheet,
  reconcileSheetColumns,
  startNewTrackerTab,
} from './core/google-sheets.js';
import { toJob, daysSince } from './core/normalize.js';

const program = new Command();

program
  .name('job-scraper')
  .description('Local job scraper. Seek implemented; other sources plug in behind one interface.')
  .option('-c, --config <path>', 'path to config file', './config/config.json')
  .option('-l, --log-level <level>', 'debug | info | warn | error', 'info');

/* -------------------------------------------------------------------- run */

program
  .command('run')
  .description('Run one or more searches and write results to the store')
  .option('-s, --source <name>', 'single source to run (default: as configured)')
  .option('-q, --query <text>', 'ad-hoc keywords, overrides config searches')
  .option('-w, --where <location>', 'ad-hoc location, used with --query')
  .option('-a, --all', 'run every enabled search in the config')
  .option('-p, --max-pages <n>', 'override max pages per search', parseIntArg)
  .option('--max-age-days <n>', 'ignore listings older than this', parseIntArg)
  .option('--detail', 'fetch the full description for each new job (one extra request per job)')
  .option('--no-detail', 'skip description fetching for this run, overriding config.defaults.fetchDetail')
  .option('--dry-run', 'scrape and print, write nothing')
  .action(async (opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);

    const searches = resolveSearches(cfg, opts);
    if (searches.length === 0) {
      rt.logger.error('Nothing to run. Add searches to config.json, or pass --query and --where.');
      process.exitCode = 2;
      return;
    }

    await rt.store.load();
    const history = await rt.store.history();

    const allStats: RunStats[] = [];
    const created: Job[] = [];
    const updated: Job[] = [];
    const seenIds = new Set<string>();

    for (const search of searches) {
      for (const sourceName of search.sources) {
        if (!hasAdapter(sourceName)) {
          rt.logger.warn(`Skipping unknown source "${sourceName}"`, { known: availableSources() });
          continue;
        }
        const sourceCfg = cfg.sources[sourceName] ?? {};
        if (sourceCfg.enabled === false) {
          rt.logger.info(`Skipping disabled source "${sourceName}"`);
          continue;
        }

        const adapter = createAdapter(sourceName, {
          http: rt.http,
          logger: rt.logger,
          settings: sourceCfg as Record<string, unknown>,
        });

        const runOpts: RunOptions = {
          maxPages: opts.maxPages ?? search.maxPages ?? cfg.defaults.maxPages,
          detail: Boolean(opts.detail ?? cfg.defaults.fetchDetail),
          dryRun: Boolean(opts.dryRun),
        };
        const maxAge = opts.maxAgeDays ?? search.maxAgeDays ?? cfg.defaults.maxAgeDays;
        if (maxAge) runOpts.maxAgeDays = maxAge;

        const query: SearchQuery = {
          query: search.query,
          location: search.location,
          sources: [sourceName],
        };
        if (search.label) query.label = search.label;
        if (search.maxPages) query.maxPages = search.maxPages;

        const res = await runSearch(adapter, query, runOpts, {
          store: rt.store,
          logger: rt.logger,
          history,
          sanityFloorRatio: cfg.defaults.sanityFloorRatio,
        });

        allStats.push(res.stats);
        created.push(...res.created);
        updated.push(...res.updated);
        for (const id of res.seenIds) seenIds.add(id);
      }
    }

    if (opts.dryRun) {
      for (const j of created) {
        console.log(
          `${j.title} | ${j.company} | ${formatLocation(j)} | ${formatSalary(j)} | ${j.url}`,
        );
      }
      rt.logger.info(`Dry run: ${created.length} jobs parsed, nothing written.`);
    } else {
      const closed = rt.store.ageOut(seenIds, cfg.defaults.closeAfterMissedRuns);
      await rt.store.save();
      const snapshot = await rt.store.writeRunSnapshot(allStats, {
        created: created.map((j) => j.id),
        updated: updated.map((j) => j.id),
      });
      rt.logger.info(
        `Saved. ${created.length} new, ${updated.length} updated, ${closed} marked closed. Snapshot: ${snapshot}`,
      );
      printNew(created);
    }

    const failed = allStats.filter((s) => !s.ok);
    if (failed.length > 0) {
      for (const f of failed) rt.logger.error(`Run not clean: ${f.source} "${f.query}"`, f.note ?? '');
      process.exitCode = 1; // so Task Scheduler shows the failure
    }
  });

/* ------------------------------------------------------------------ stats */

program
  .command('stats')
  .description('Summarise what is in the store')
  .action(async () => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();
    const jobs = dedupeById(rt.store.all());

    const open = jobs.filter((j) => !j.closed);
    const bySource = new Map<string, number>();
    const byCompany = new Map<string, number>();
    const byStatus = new Map<string, number>();
    let withSalary = 0;
    let newToday = 0;

    for (const j of jobs) byStatus.set(j.pipelineStatus, (byStatus.get(j.pipelineStatus) ?? 0) + 1);

    for (const j of open) {
      for (const s of j.seenOn) bySource.set(s, (bySource.get(s) ?? 0) + 1);
      byCompany.set(j.company, (byCompany.get(j.company) ?? 0) + 1);
      if (j.salary) withSalary++;
      const age = daysSince(j.scrapedAt);
      if (age !== undefined && age < 1) newToday++;
    }

    console.log(`Jobs stored:      ${jobs.length}`);
    console.log(`Open:             ${open.length}`);
    console.log(`Closed:           ${jobs.length - open.length}`);
    console.log(`First seen <24h:  ${newToday}`);
    console.log(
      `With salary:      ${withSalary} (${open.length ? Math.round((withSalary / open.length) * 100) : 0}%)`,
    );
    console.log('\nBy pipeline status:');
    for (const status of ['scraped', 'fit_good', 'fit_bad', 'tracked', 'applied']) {
      console.log(`  ${status.padEnd(12)} ${byStatus.get(status) ?? 0}`);
    }
    console.log('\nBy source:');
    for (const [s, n] of [...bySource].sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(12)} ${n}`);
    console.log('\nTop companies:');
    for (const [c, n] of [...byCompany].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${String(n).padStart(4)}  ${c}`);
    }
  });

/* ----------------------------------------------------------------- export */

program
  .command('export')
  .description('Export the store to CSV or JSON')
  .option('-f, --format <fmt>', 'csv | json', 'csv')
  .option('--since <dur>', 'only jobs first seen within this window, e.g. 7d')
  .option('--source <name>', 'filter by source')
  .option('--tag <tag...>', 'only jobs carrying all of these tags')
  .option('--status <status...>', 'only jobs in one of these pipeline statuses (scraped, fit_good, fit_bad, tracked, applied)')
  .option('--open-only', 'exclude jobs marked closed', true)
  .option('-o, --out <path>', 'output file (default: stdout)')
  .action(async (opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    let jobs = dedupeById(rt.store.all());
    if (opts.openOnly) jobs = jobs.filter((j) => !j.closed);
    if (opts.status?.length) jobs = jobs.filter((j) => opts.status.includes(j.pipelineStatus));
    if (opts.source) jobs = jobs.filter((j) => j.seenOn.includes(opts.source));
    if (opts.tag?.length) jobs = jobs.filter((j) => opts.tag.every((t: string) => j.tags.includes(t)));
    if (opts.since) {
      const cutoff = Date.now() - parseDuration(opts.since);
      jobs = jobs.filter((j) => Date.parse(j.scrapedAt) >= cutoff);
    }
    jobs.sort((a, b) => (b.postedAt ?? b.scrapedAt).localeCompare(a.postedAt ?? a.scrapedAt));

    const body = opts.format === 'json' ? JSON.stringify(jobs, null, 2) : toCsv(jobs);
    if (opts.out) {
      await writeFile(resolve(opts.out), body, 'utf8');
      rt.logger.info(`Wrote ${jobs.length} jobs to ${opts.out}`);
    } else {
      console.log(body);
    }
  });

/* ------------------------------------------------------- stage: fit-filter */

program
  .command('export-fit-inbox')
  .description(
    'Write a small, clean file of jobs the fit-filter agent has not judged yet. ' +
      'Plain filtering, no LLM involved — safe to run before every fit-filter pass.',
  )
  .option('--max-age-days <n>', 'override pipeline.fitInboxMaxAgeDays', parseIntArg)
  .option('-o, --out <path>', 'override pipeline.fitInboxPath')
  .action(async (opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const jobs = dedupeById(rt.store.all());
    const selected = selectForStage(jobs, 'fit-filter', {
      maxAgeDays: opts.maxAgeDays ?? cfg.pipeline.fitInboxMaxAgeDays,
    });
    selected.sort((a, b) => (b.postedAt ?? b.scrapedAt).localeCompare(a.postedAt ?? a.scrapedAt));

    const outPath = resolve(opts.out ?? cfg.pipeline.fitInboxPath);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(selected.map(toCleanJob), null, 2), 'utf8');
    rt.logger.info(
      `Wrote ${selected.length} job(s) awaiting a fit verdict to ${outPath} ` +
        `(${jobs.length - selected.length} excluded: already judged, closed, or older than ` +
        `${opts.maxAgeDays ?? cfg.pipeline.fitInboxMaxAgeDays} days)`,
    );
  });

const VerdictsSchema = z.array(
  z.object({
    id: z.string(),
    verdict: z.enum(['good', 'bad']),
    reason: z.string().optional(),
  }),
);

program
  .command('apply-fit-verdicts <file>')
  .description(
    'Apply the fit-filter agent\'s verdicts back to the master store. ' +
      'Plain code — the agent never touches jobs.json directly.',
  )
  .action(async (file) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const parsed = VerdictsSchema.safeParse(JSON.parse(await readFile(resolve(file), 'utf8')));
    if (!parsed.success) {
      rt.logger.error(`${file} is not a valid verdicts file`, parsed.error.issues);
      process.exitCode = 2;
      return;
    }

    let applied = 0;
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const v of parsed.data) {
      const to: PipelineStatus = v.verdict === 'good' ? 'fit_good' : 'fit_bad';
      const res = rt.store.updateStatus(v.id, to, { actor: 'fit-filter-agent', reason: v.reason });
      if (res.ok) applied++;
      else skipped.push({ id: v.id, reason: res.reason });
    }

    await rt.store.save();
    await writeVerdictLog(cfg.dataDir, 'fit-verdicts', parsed.data, skipped);

    rt.logger.info(`Applied ${applied} verdict(s). Skipped ${skipped.length}.`);
    for (const s of skipped.slice(0, 20)) rt.logger.warn(`Skipped ${s.id}: ${s.reason}`);
    if (skipped.length > 20) rt.logger.warn(`... and ${skipped.length - 20} more skipped`);
  });

/* ---------------------------------------------------------- stage: tracker */

program
  .command('export-tracker-inbox')
  .description(
    'Write two small, clean files of fit_good jobs the tracker/cover-letter agent has not seen yet: ' +
      'AU jobs to pipeline.trackerInboxPath, everything else (by location.country) to pipeline.trackerInboxIntlPath.',
  )
  .option('-o, --out <path>', 'override pipeline.trackerInboxPath (AU file only)')
  .action(async (opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const jobs = dedupeById(rt.store.all());
    const selected = selectForStage(jobs, 'tracker');
    selected.sort((a, b) => (b.postedAt ?? b.scrapedAt).localeCompare(a.postedAt ?? a.scrapedAt));

    const au = selected.filter((j) => j.location.country === 'AU');
    const intl = selected.filter((j) => j.location.country !== 'AU');

    const outPath = resolve(opts.out ?? cfg.pipeline.trackerInboxPath);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(au.map(toCleanJob), null, 2), 'utf8');

    const intlPath = resolve(cfg.pipeline.trackerInboxIntlPath);
    await mkdir(dirname(intlPath), { recursive: true });
    await writeFile(intlPath, JSON.stringify(intl.map(toCleanJob), null, 2), 'utf8');

    rt.logger.info(
      `Wrote ${au.length} AU good-fit job(s) to ${outPath}, ${intl.length} international to ${intlPath}`,
    );
  });

/* --------------------------------------------------- stage: career profile */

program
  .command('export-profile-inbox')
  .description(
    'Write a small file of tracked jobs with no career profile yet, for the career-profile ' +
      'tailoring step. Excludes jobs that already have one (from the LLM step or typed straight ' +
      'into the Sheet) and anything not pipelineStatus "tracked" (applied jobs are done; fit_good ' +
      'jobs get promoted to tracked by sync-sheet first). No LLM involved in building this file.',
  )
  .option('-o, --out <path>', 'override pipeline.profileInboxPath')
  .action(async (opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const jobs = dedupeById(rt.store.all());
    const selected = selectForStage(jobs, 'career-profile');
    selected.sort((a, b) => (b.postedAt ?? b.scrapedAt).localeCompare(a.postedAt ?? a.scrapedAt));

    const outPath = resolve(opts.out ?? cfg.pipeline.profileInboxPath);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(selected.map(toProfileJob), null, 2), 'utf8');
    rt.logger.info(`Wrote ${selected.length} job(s) awaiting a career profile to ${outPath}`);
  });

const ProfileVerdictsSchema = z.array(
  z.union([
    z.object({ id: z.string(), career_profile: z.string(), technical_skills: z.array(z.string()) }),
    z.object({ id: z.string(), error: z.literal('disqualifying_requirement') }),
    z.object({ id: z.string(), error: z.literal('needs_clarification'), questions: z.array(z.string()).min(1) }),
  ]),
);

program
  .command('apply-career-profiles <file>')
  .description(
    'Apply the career-profile tailoring step\'s output back into the master file. Plain code — ' +
      'the LLM step never touches jobs.json directly. Accepts the tailoring prompt\'s own per-job ' +
      'JSON shape, each entry tagged with the job id: {id, career_profile, technical_skills} on ' +
      'success, or {id, error: "disqualifying_requirement"} / {id, error: "needs_clarification", ' +
      'questions} when the LLM couldn\'t produce one. Never touches pipelineStatus.',
  )
  .action(async (file) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const parsed = ProfileVerdictsSchema.safeParse(JSON.parse(await readFile(resolve(file), 'utf8')));
    if (!parsed.success) {
      rt.logger.error(`${file} is not a valid career-profile verdicts file`, parsed.error.issues);
      process.exitCode = 2;
      return;
    }

    let done = 0;
    let flagged = 0;
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const v of parsed.data) {
      const res =
        'career_profile' in v
          ? rt.store.setProfile(v.id, { careerProfile: v.career_profile, technicalSkills: v.technical_skills })
          : rt.store.setProfile(v.id, {
              profileNote:
                v.error === 'disqualifying_requirement'
                  ? 'DISQUALIFYING REQUIREMENT (visa/clearance/citizenship) — review manually.'
                  : `NEEDS CLARIFICATION: ${v.questions.join(' | ')}`,
            });
      if (!res.ok) {
        skipped.push({ id: v.id, reason: res.reason });
        continue;
      }
      if ('career_profile' in v) done++;
      else flagged++;
    }

    await rt.store.save();
    rt.logger.info(
      `Career profiles: ${done} written, ${flagged} flagged for review, ${skipped.length} skipped.`,
    );
    for (const s of skipped.slice(0, 20)) rt.logger.warn(`Skipped ${s.id}: ${s.reason}`);
  });

/* ----------------------------------------------------- stage: cover letter */

program
  .command('export-coverletter-inbox')
  .description(
    'Write a small file of tracked jobs that already have a career profile but no cover ' +
      'letter yet, for the cover-letter drafting step. Always runs after the career-profile ' +
      'step within the same pipeline run, so a profile written earlier in that run is ' +
      'immediately eligible. No LLM involved in building this file.',
  )
  .option('-o, --out <path>', 'override pipeline.coverLetterInboxPath')
  .action(async (opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const jobs = dedupeById(rt.store.all());
    const selected = selectForStage(jobs, 'cover-letter');
    selected.sort((a, b) => (b.postedAt ?? b.scrapedAt).localeCompare(a.postedAt ?? a.scrapedAt));

    const outPath = resolve(opts.out ?? cfg.pipeline.coverLetterInboxPath);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(selected.map(toCoverLetterJob), null, 2), 'utf8');
    rt.logger.info(`Wrote ${selected.length} job(s) awaiting a cover letter to ${outPath}`);
  });

const CoverLetterVerdictsSchema = z.array(
  z.union([
    z.object({ id: z.string(), cover_letter: z.string() }),
    z.object({ id: z.string(), error: z.literal('needs_clarification'), questions: z.array(z.string()).min(1) }),
  ]),
);

program
  .command('apply-cover-letters <file>')
  .description(
    'Apply the cover-letter drafting step\'s output back into the master file. Plain code — ' +
      'the LLM step never touches jobs.json directly. Accepts {id, cover_letter} on success, or ' +
      '{id, error: "needs_clarification", questions} when the LLM couldn\'t produce one.',
  )
  .action(async (file) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const parsed = CoverLetterVerdictsSchema.safeParse(JSON.parse(await readFile(resolve(file), 'utf8')));
    if (!parsed.success) {
      rt.logger.error(`${file} is not a valid cover-letter verdicts file`, parsed.error.issues);
      process.exitCode = 2;
      return;
    }

    let done = 0;
    let flagged = 0;
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const v of parsed.data) {
      const res =
        'cover_letter' in v
          ? rt.store.setCoverLetter(v.id, { coverLetter: v.cover_letter })
          : rt.store.setCoverLetter(v.id, { coverLetterNote: `NEEDS CLARIFICATION: ${v.questions.join(' | ')}` });
      if (!res.ok) {
        skipped.push({ id: v.id, reason: res.reason });
        continue;
      }
      if ('cover_letter' in v) done++;
      else flagged++;
    }

    await rt.store.save();
    rt.logger.info(
      `Cover letters: ${done} written, ${flagged} flagged for review, ${skipped.length} skipped.`,
    );
    for (const s of skipped.slice(0, 20)) rt.logger.warn(`Skipped ${s.id}: ${s.reason}`);
  });

/* -------------------------------------------------------- marking applied */

program
  .command('mark-applied [ids...]')
  .description('Mark one or more jobs applied by id. Manual escape hatch alongside sync-applied.')
  .option('--from <file>', 'read ids from a text file, one per line, instead of/in addition to arguments')
  .action(async (ids: string[], opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const allIds = [...ids];
    if (opts.from) {
      const text = await readFile(resolve(opts.from), 'utf8');
      allIds.push(...text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    }
    if (allIds.length === 0) {
      rt.logger.error('No ids given. Pass them as arguments or with --from <file>.');
      process.exitCode = 2;
      return;
    }

    let applied = 0;
    for (const id of allIds) {
      const res = rt.store.updateStatus(id, 'applied', { actor: 'manual' });
      if (res.ok) applied++;
      else rt.logger.warn(`Skipped ${id}: ${res.reason}`);
    }
    await rt.store.save();
    rt.logger.info(`Marked ${applied} of ${allIds.length} job(s) applied.`);
  });

program
  .command('sync-applied <file>')
  .description(
    'Placeholder for the Google Sheet integration: mark jobs applied from an exported file. ' +
      'Accepts JSON ([{id, applied}] or [{url, applied}]) or a simple CSV with id/url/applied columns. ' +
      'Once the real Sheets API is wired up, point this at whatever it produces, or replace this ' +
      'command\'s file-read with an API call — everything downstream (updateStatus, the ratchet) stays the same.',
  )
  .action(async (file) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const rows = await readAppliedFile(resolve(file));
    const byUrl = new Map(dedupeById(rt.store.all()).map((j) => [j.url, j.id]));

    let applied = 0;
    const skipped: Array<{ ref: string; reason: string }> = [];
    for (const row of rows) {
      if (!row.applied) continue;
      const id = row.id ?? (row.url ? byUrl.get(row.url) : undefined);
      if (!id) {
        skipped.push({ ref: row.id ?? row.url ?? '(blank)', reason: 'no matching job in the store' });
        continue;
      }
      const res = rt.store.updateStatus(id, 'applied', { actor: 'sheet-sync' });
      if (res.ok) applied++;
      else skipped.push({ ref: id, reason: res.reason });
    }

    await rt.store.save();
    rt.logger.info(`Sheet sync: marked ${applied} job(s) applied. Skipped ${skipped.length}.`);
    for (const s of skipped.slice(0, 20)) rt.logger.warn(`Skipped ${s.ref}: ${s.reason}`);
  });

/* ------------------------------------------------------ stage: sheet sync */

program
  .command('google-auth')
  .description(
    'One-time interactive setup: authorize this app against your Google account so ' +
      'sync-sheet can write to the tracker Sheet unattended. Run this by hand once ' +
      '(see docs/google-sheets-setup.md), never from the scheduled pipeline.',
  )
  .action(async () => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    await runInteractiveAuth(cfg.pipeline.sheets);
  });

program
  .command('sync-sheet [file]')
  .description(
    'Deterministic, no-LLM sync: appends fit_good jobs to the Google Sheet tracker ' +
      '(deduped by Job ID, header row created on first use) and advances each ' +
      'successfully-synced job to pipelineStatus "tracked" so it is never re-sent. ' +
      'Defaults to reading pipeline.trackerInboxPath (export-tracker-inbox\'s output). ' +
      'Pass --intl to sync the international file/sheet instead.',
  )
  .option('--intl', 'sync pipeline.trackerInboxIntlPath into pipeline.sheetsIntl instead of the AU pair')
  .action(async (file: string | undefined, opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);

    const sheetsKey = opts.intl ? 'sheetsIntl' : 'sheets';
    const sheetsCfg = cfg.pipeline[sheetsKey];
    if (!sheetsCfg.spreadsheetId) {
      rt.logger.error(`pipeline.${sheetsKey}.spreadsheetId is not set in config.json. See docs/google-sheets-setup.md.`);
      process.exitCode = 2;
      return;
    }

    const inboxPath = resolve(
      file ?? (opts.intl ? cfg.pipeline.trackerInboxIntlPath : cfg.pipeline.trackerInboxPath),
    );
    let jobs: CleanJob[];
    try {
      jobs = JSON.parse(await readFile(inboxPath, 'utf8')) as CleanJob[];
    } catch (err) {
      rt.logger.error(`Could not read ${inboxPath}. Run export-tracker-inbox first.`, String(err));
      process.exitCode = 2;
      return;
    }

    const auth = await getAuthorizedClient(sheetsCfg);
    await rt.store.load();

    let tracked = 0;
    const skipped: Array<{ id: string; reason: string }> = [];

    if (jobs.length === 0) {
      rt.logger.info(`No jobs in ${inboxPath} to append.`);
    } else {
      const result = await syncJobsToSheet(auth, sheetsCfg, jobs);
      for (const id of [...result.appended, ...result.alreadyPresent]) {
        const res = rt.store.updateStatus(id, 'tracked', { actor: 'sheet-sync' });
        if (res.ok) tracked++;
        else if (res.reason !== 'already tracked') skipped.push({ id, reason: res.reason });
      }
      rt.logger.info(
        `Sheet sync: ${result.appended.length} new row(s) added, ${result.alreadyPresent.length} already present. ` +
          `${tracked} job(s) marked tracked.`,
      );
      if (skipped.length > 0) {
        rt.logger.warn(`${skipped.length} job(s) synced to the sheet but could not be marked tracked:`);
        for (const s of skipped.slice(0, 20)) rt.logger.warn(`  ${s.id}: ${s.reason}`);
      }
    }

    // Always reconcile every editable column, regardless of whether there
    // was anything new to append above — this is what pushes a freshly-
    // generated career profile/cover letter into the sheet, pulls back
    // anything Anshu typed into the sheet by hand so jobs.json agrees and
    // the relevant export-*-inbox command leaves that job alone from now
    // on, and pulls back the Applied checkbox and Stages dropdown so no
    // agent is sent a job he's already recorded an outcome for.
    const jobsById = new Map(dedupeById(rt.store.all()).map((j) => [j.id, j]));
    const reconciled = await reconcileSheetColumns(auth, sheetsCfg, jobsById);
    for (const p of reconciled.profilePulledBack) {
      rt.store.setProfile(p.id, { careerProfile: p.careerProfile, technicalSkills: p.technicalSkills });
    }
    for (const c of reconciled.coverLetterPulledBack) {
      rt.store.setCoverLetter(c.id, { coverLetter: c.coverLetter });
    }
    for (const id of reconciled.markedApplied) {
      rt.store.updateStatus(id, 'applied', { actor: 'sheet-sync' });
    }
    for (const stage of reconciled.interviewStages) {
      rt.store.setInterviewStage(stage.id, stage.stage);
    }
    await rt.store.save();

    const reconcileTotal =
      reconciled.profilePulledBack.length +
      reconciled.coverLetterPulledBack.length +
      reconciled.markedApplied.length +
      reconciled.interviewStages.length +
      reconciled.pushed.length;
    if (reconcileTotal > 0) {
      rt.logger.info(
        `Sheet reconcile: ${reconciled.pushed.length} cell(s) pushed, ` +
          `${reconciled.profilePulledBack.length} profile edit(s) and ${reconciled.coverLetterPulledBack.length} ` +
          `cover-letter edit(s) pulled back, ${reconciled.markedApplied.length} job(s) marked applied, ` +
          `${reconciled.interviewStages.length} interview stage(s) recorded.`,
      );
    }
  });

program
  .command('new-tracker-tab')
  .description(
    'Rotate the tracker onto a fresh tab (duplicates the current tab, keeping its Table/dropdown/' +
      'formatting setup, clears its data rows, and points config.json\'s pipeline.sheets.sheetName ' +
      '(or pipeline.sheetsIntl.sheetName with --intl) at the new tab). Run this by hand whenever the ' +
      'current tab gets too big to work with.',
  )
  .option('--intl', 'rotate the international tracker sheet instead of the AU one')
  .action(async (opts) => {
    const g = program.opts();
    const configPath = resolve(g.config);
    const cfg = await loadConfig(configPath);
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);

    const sheetsKey = opts.intl ? 'sheetsIntl' : 'sheets';
    const sheetsCfg = cfg.pipeline[sheetsKey];
    if (!sheetsCfg.spreadsheetId) {
      rt.logger.error(`pipeline.${sheetsKey}.spreadsheetId is not set in config.json. See docs/google-sheets-setup.md.`);
      process.exitCode = 2;
      return;
    }

    const auth = await getAuthorizedClient(sheetsCfg);
    const { oldTab, newTab } = await startNewTrackerTab(auth, sheetsCfg);

    const rawConfig = JSON.parse(await readFile(configPath, 'utf8')) as {
      pipeline: { sheets: { sheetName: string }; sheetsIntl: { sheetName: string } };
    };
    rawConfig.pipeline[sheetsKey].sheetName = newTab;
    await writeFile(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, 'utf8');

    rt.logger.info(
      `Created tab "${newTab}" from "${oldTab}" and updated config.json (pipeline.${sheetsKey}) to use it from now on.`,
    );
  });

/* -------------------------------------------------------------------- replay */

program
  .command('replay <file>')
  .description(
    'Debug helper: run one RawJob (or an already-parsed Job) through normalize -> dedupe -> store, ' +
      'printing what happens at each stage. No network calls. Pair with the VS Code "Debug: replay" ' +
      'launch config to set breakpoints and step through it.',
  )
  .option('--query <text>', 'the search query to attribute this job to', 'replay')
  .option('--commit', 'actually save to jobs.json (default: dry run)')
  .action(async (file, opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const input = JSON.parse(await readFile(resolve(file), 'utf8')) as RawJob;
    console.log('--- 1. RawJob in ---');
    console.log(JSON.stringify(input, null, 2));

    const job = toJob(input, 'seek', opts.query);
    console.log('\n--- 2. Normalized Job ---');
    console.log(JSON.stringify(job, null, 2));

    const existingById = rt.store.get(job.id);
    console.log('\n--- 3. Store lookup ---');
    console.log(
      existingById
        ? `Exact id match found (pipelineStatus=${existingById.pipelineStatus}). This will UPDATE, preserving that status.`
        : 'No exact id match. Will check fingerprint/fuzzy match next, inside upsert().',
    );

    if (opts.commit) {
      const res = rt.store.upsert(job);
      await rt.store.save();
      console.log('\n--- 4. Upsert result (committed) ---');
      console.log(`status: ${res.status}, final pipelineStatus: ${res.job.pipelineStatus}`);
    } else {
      console.log('\n--- 4. Upsert result ---');
      console.log('Skipped (dry run). Pass --commit to actually write to jobs.json.');
    }
  });

/* --------------------------------------------------------------- discover */

program
  .command('discover')
  .description("Save one raw response from a source so you can inspect its current shape")
  .requiredOption('-s, --source <name>', 'source to probe')
  .option('-q, --query <text>', 'keywords', 'software engineer')
  .option('-w, --where <location>', 'location', 'All Melbourne VIC')
  .action(async (opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, 'debug');

    const adapter = createAdapter(opts.source, {
      http: rt.http,
      logger: rt.logger,
      settings: (cfg.sources[opts.source] ?? {}) as Record<string, unknown>,
    });
    if (!adapter.discover) {
      rt.logger.error(`Source "${opts.source}" does not implement discover()`);
      process.exitCode = 2;
      return;
    }

    const payload = await adapter.discover({
      query: opts.query,
      location: opts.where,
      sources: [opts.source],
    });
    const dir = join(cfg.dataDir, '.cache');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${opts.source}-sample.json`);
    await writeFile(file, JSON.stringify(payload, null, 2), 'utf8');

    const top = payload && typeof payload === 'object' ? Object.keys(payload) : [];
    const rows = (payload as { data?: unknown[] })?.data;
    console.log(`\nSaved raw response to ${file}`);
    console.log(`Top-level keys: ${top.join(', ') || '(none)'}`);
    if (Array.isArray(rows) && rows[0] && typeof rows[0] === 'object') {
      console.log(`data[0] keys:   ${Object.keys(rows[0] as object).join(', ')}`);
      console.log(`data length:    ${rows.length}`);
    } else {
      console.log('No data[] array found. The endpoint or its parameters need updating in config.json.');
    }
  });

/* ---------------------------------------------------------------- sources */

program
  .command('sources')
  .description('List registered adapters')
  .action(() => {
    for (const s of availableSources()) console.log(s);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(String(err instanceof Error ? err.stack ?? err.message : err));
  process.exit(1);
});

/* --------------------------------------------------------------- plumbing */

function makeRuntime(cfg: Config, level: LogLevel) {
  const logger = new Logger({ level, file: join(cfg.dataDir, 'logs', 'scraper.log') });
  // RateLimiter paces every host from these two numbers (it keys its own
  // internal queues per host, but takes one shared minDelayMs/jitterMs for
  // all of them). Previously this only ever read sources.seek, so a
  // stricter minDelayMs configured for another source (e.g. LinkedIn's
  // recommended 3000ms+) was silently ignored. Take the strictest
  // (largest) value configured across enabled sources instead, so no
  // source gets paced faster than it asked for.
  const enabledSources = Object.values(cfg.sources).filter((src) => src?.enabled !== false);
  const minDelayMs = Math.max(1500, ...enabledSources.map((src) => src.minDelayMs ?? 0));
  const jitterMs = Math.max(1500, ...enabledSources.map((src) => src.jitterMs ?? 0));
  const limiter = new RateLimiter(minDelayMs, jitterMs);
  const cache = new ResponseCache(
    join(cfg.dataDir, '.cache'),
    cfg.cache.ttlMinutes * 60_000,
    cfg.cache.enabled,
  );
  const http = new HttpClient({ limiter, cache, logger, userAgent: cfg.userAgent });
  const store = new JsonStore(cfg.dataDir, cfg.defaults.fuzzyDedupe);
  return { logger, http, store, cache };
}

function resolveSearches(cfg: Config, opts: Record<string, unknown>): SearchConfig[] {
  if (opts.query) {
    const sources = opts.source ? [String(opts.source)] : availableSources();
    return [
      {
        query: String(opts.query),
        location: String(opts.where ?? 'All Australia'),
        sources,
        enabled: true,
      },
    ];
  }
  const enabled = cfg.searches.filter((s) => s.enabled);
  const chosen = opts.source
    ? enabled
        .filter((s) => s.sources.includes(String(opts.source)))
        .map((s) => ({ ...s, sources: [String(opts.source)] }))
    : enabled;
  return opts.all || chosen.length > 0 ? chosen : [];
}

/** The store maps several ids onto one merged record; collapse before counting. */
function dedupeById(jobs: Job[]): Job[] {
  const seen = new Map<string, Job>();
  for (const j of jobs) if (!seen.has(j.id)) seen.set(j.id, j);
  return [...seen.values()];
}

function printNew(created: Job[]): void {
  if (created.length === 0) return;
  console.log('\nNew since last run:');
  for (const j of created.slice(0, 30)) {
    console.log(`  ${j.title} — ${j.company} (${formatLocation(j)}) ${formatSalary(j)}`);
    console.log(`    ${j.url}`);
  }
  if (created.length > 30) console.log(`  ... and ${created.length - 30} more`);
}

function parseIntArg(v: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${v}"`);
  return n;
}

/** Small audit trail of every apply-fit-verdicts run, separate from the log file. */
async function writeVerdictLog(
  dataDir: string,
  kind: string,
  input: unknown,
  skipped: Array<{ id: string; reason: string }>,
): Promise<void> {
  const dir = join(dataDir, 'logs', 'verdicts');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(
    join(dir, `${kind}-${stamp}.json`),
    JSON.stringify({ at: new Date().toISOString(), input, skipped }, null, 2),
    'utf8',
  );
}

interface AppliedRow {
  id?: string;
  url?: string;
  applied: boolean;
}

/**
 * Reads the file that stands in for the Google Sheet today. Accepts JSON
 * (an array of {id?, url?, applied}) or a simple CSV with an "applied"
 * column plus "id" and/or "url". When the real Sheets API is wired up,
 * replace this function's body with an API call that returns the same
 * AppliedRow[] shape — nothing else in sync-applied needs to change.
 */
async function readAppliedFile(path: string): Promise<AppliedRow[]> {
  const text = await readFile(path, 'utf8');
  if (path.endsWith('.json')) {
    return z
      .array(z.object({ id: z.string().optional(), url: z.string().optional(), applied: z.coerce.boolean() }))
      .parse(JSON.parse(text));
  }

  // Minimal CSV: no quoted-field support, fine for a simple id/url/applied export.
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = (lines.shift() ?? '').split(',').map((h) => h.trim().toLowerCase());
  const idIdx = header.indexOf('id');
  const urlIdx = header.indexOf('url');
  const appliedIdx = header.indexOf('applied');
  if (appliedIdx === -1) throw new Error(`${path} has no "applied" column`);

  return lines.map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    const row: AppliedRow = { applied: /^(true|yes|1|y)$/i.test(cells[appliedIdx] ?? '') };
    if (idIdx !== -1 && cells[idIdx]) row.id = cells[idIdx];
    if (urlIdx !== -1 && cells[urlIdx]) row.url = cells[urlIdx];
    return row;
  });
}
