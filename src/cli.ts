#!/usr/bin/env node
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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
import {
  toCleanJob,
  selectForStage,
  toProfileJob,
  toCoverLetterJob,
  toMaterialsJob,
  toDocumentJob,
  buildResumeFileName,
  buildCoverLetterFileName,
  resumeDocFor,
  pickResumeVersion,
  type CleanJob,
} from './core/stage-export.js';
import { RESUME_VERSIONS } from './core/resume-version.js';
import { applyMaterials, MaterialsVerdictsSchema, type MaterialsReport, type MaterialsVerdict } from './core/materials.js';
import {
  batchRootWindows,
  emptyIndex,
  findActiveBatch,
  inputsHash,
  newBatchName,
  pickFileNames,
  readIndex,
  resolveCompanyFolder,
  writeIndex,
} from './core/documents-index.js';
import { buildApplyQueue, platformOf } from './core/apply-queue.js';
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

const ResumeVersionEnum = z.enum(RESUME_VERSIONS as [string, ...string[]]);

/** Shared by every apply-* command: print the outcome and exit non-zero when anything was rejected, so a scheduled run notices. */
function reportMaterials(rt: Runtime, label: string, report: MaterialsReport, dryRun: boolean): void {
  rt.logger.info(
    `${label}${dryRun ? ' (dry run, nothing written)' : ''}: ${report.profilesWritten} career profile(s), ` +
      `${report.lettersWritten} cover letter(s) accepted, ${report.flagged} flagged for review, ${report.skipped.length} rejected.`,
  );
  for (const s of report.skipped.slice(0, 40)) rt.logger.warn(`Rejected ${s.id} [${s.piece}]: ${s.reasons.join('; ')}`);
  console.log(`MATERIALS_RESULT ${JSON.stringify(report)}`);
  if (report.skipped.length > 0) process.exitCode = 3;
}

const ProfileVerdictsSchema = z.array(
  z.union([
    z.object({ id: z.string(), resume_version: ResumeVersionEnum, career_profile: z.string() }),
    z.object({ id: z.string(), resume_version: ResumeVersionEnum, error: z.literal('disqualifying_requirement') }),
    z.object({
      id: z.string(),
      resume_version: ResumeVersionEnum,
      error: z.literal('needs_clarification'),
      questions: z.array(z.string()).min(1),
    }),
  ]),
);

program
  .command('apply-career-profiles <file>')
  .description(
    'Apply the career-profile step\'s output back into the master file. Plain code: the LLM never ' +
      'touches jobs.json directly. Each entry is {id, resume_version, career_profile} on success, or ' +
      '{id, resume_version, error: "disqualifying_requirement"} / {id, resume_version, error: ' +
      '"needs_clarification", questions}. resume_version must equal the job\'s own classification ' +
      '(the inbox carries it) and every profile passes the deterministic lint, otherwise the entry is ' +
      'rejected. Prefer apply-materials, which handles the profile and the cover letter together.',
  )
  .option('--dry-run', 'validate only, write nothing')
  .action(async (file, opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const parsed = ProfileVerdictsSchema.safeParse(JSON.parse(await readFile(resolve(file), 'utf8')));
    if (!parsed.success) {
      rt.logger.error(`${file} is not a valid career-profile verdicts file (every entry needs id and resume_version)`, parsed.error.issues);
      process.exitCode = 2;
      return;
    }
    const report = applyMaterials(rt.store, parsed.data as MaterialsVerdict[], { dryRun: opts.dryRun });
    if (!opts.dryRun) await rt.store.save();
    reportMaterials(rt, 'Career profiles', report, Boolean(opts.dryRun));
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
    z.object({ id: z.string(), resume_version: ResumeVersionEnum, cover_letter: z.string() }),
    z.object({
      id: z.string(),
      resume_version: ResumeVersionEnum,
      error: z.literal('needs_clarification'),
      questions: z.array(z.string()).min(1),
    }),
  ]),
);

program
  .command('apply-cover-letters <file>')
  .description(
    'Apply the cover-letter step\'s output back into the master file. Each entry is {id, resume_version, ' +
      'cover_letter} on success, or {id, resume_version, error: "needs_clarification", questions}. Same ' +
      'version check and lint as apply-career-profiles. Prefer apply-materials.',
  )
  .option('--dry-run', 'validate only, write nothing')
  .action(async (file, opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const parsed = CoverLetterVerdictsSchema.safeParse(JSON.parse(await readFile(resolve(file), 'utf8')));
    if (!parsed.success) {
      rt.logger.error(`${file} is not a valid cover-letter verdicts file (every entry needs id and resume_version)`, parsed.error.issues);
      process.exitCode = 2;
      return;
    }
    const verdicts: MaterialsVerdict[] = parsed.data.map((v) =>
      'error' in v ? { ...v, error_stage: 'cover_letter' as const } : v,
    ) as MaterialsVerdict[];
    const report = applyMaterials(rt.store, verdicts, { dryRun: opts.dryRun });
    if (!opts.dryRun) await rt.store.save();
    reportMaterials(rt, 'Cover letters', report, Boolean(opts.dryRun));
  });

/* ------------------------------------ stage: career profile + cover letter */

program
  .command('export-materials-inbox')
  .description(
    'Write one small file for the combined career-profile + cover-letter step: every tracked, open job ' +
      'that still needs either piece (missing, or written from a different resume version than the job ' +
      'classifies as now), the JD once, which base resume file to use, and which pieces are needed. No LLM ' +
      'involved in building it.',
  )
  .option('-o, --out <path>', 'override pipeline.materialsInboxPath')
  .action(async (opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const jobs = dedupeById(rt.store.all());
    const selected = selectForStage(jobs, 'materials');
    selected.sort((a, b) => (b.postedAt ?? b.scrapedAt).localeCompare(a.postedAt ?? a.scrapedAt));

    const items = selected.map(toMaterialsJob);
    const outPath = resolve(opts.out ?? cfg.pipeline.materialsInboxPath);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(items, null, 2), 'utf8');

    const byVersion = (v: string) => items.filter((i) => i.resumeVersion === v).length;
    const both = items.filter((i) => i.needs.length === 2).length;
    rt.logger.info(
      `Wrote ${items.length} job(s) to ${outPath}: ${both} need both pieces, ${items.length - both} need one; ` +
        `${byVersion('software-engineer')} software-engineer, ${byVersion('test-analyst')} test-analyst.`,
    );
  });

program
  .command('apply-materials <file>')
  .description(
    'Apply the combined step\'s output back into the master file. Entries: {id, resume_version, career_profile?, ' +
      'cover_letter?} or {id, resume_version, error: "disqualifying_requirement" | "needs_clarification", ' +
      'questions?, error_stage?}. resume_version must match the job\'s classification and every text passes ' +
      'the deterministic lint (em dashes, word counts, placeholders, company mention, salutation). Rejected ' +
      'entries are listed with reasons, nothing else is affected, and the exit code is 3 so the caller can ' +
      'fix just those and re-run. --dry-run validates without writing.',
  )
  .option('--dry-run', 'validate only, write nothing')
  .action(async (file, opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const parsed = MaterialsVerdictsSchema.safeParse(JSON.parse(await readFile(resolve(file), 'utf8')));
    if (!parsed.success) {
      rt.logger.error(`${file} is not a valid materials verdicts file`, parsed.error.issues);
      process.exitCode = 2;
      return;
    }
    const report = applyMaterials(rt.store, parsed.data, { dryRun: opts.dryRun });
    if (!opts.dryRun) await rt.store.save();
    reportMaterials(rt, 'Materials', report, Boolean(opts.dryRun));
  });

/* -------------------------------------------------------------- documents */


program
  .command('generate-documents')
  .description(
    'Zero-LLM-cost stage: for every unapplied tracked job whose career profile and cover letter are ' +
      'present and current (written from the resume version the job classifies as), swap the profile ' +
      'into the matching base resume Google Doc, build a matching cover letter, and export both as PDFs ' +
      'into one folder per company inside a brand-new timestamped batch folder under ' +
      'pipeline.documentsOutputDir (override the root with $SCRAPER_DOCS_OUTPUT_DIR inside the Claude ' +
      'Cowork device_bash sandbox). Every run starts a fresh batch folder: a still-open job unchanged since ' +
      'the last run has its existing PDFs copied across (not rebuilt); an applied/closed job is simply left ' +
      'out, so the new batch only ever holds what is still pending, never growing without bound. Only new or ' +
      'changed jobs are rebuilt (--force rebuilds everything). documents-index.json in the batch folder ' +
      'records which files belong to which job. ' +
      'International jobs get a +61 phone and a "PTE: 88" headline addition. Needs python3 (python-docx) ' +
      'and LibreOffice (soffice) on PATH.',
  )
  .option('--force', 'rebuild every eligible job, not just new or changed ones (use after editing a base resume Google Doc)')
  .action(async (opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    const jobs = dedupeById(rt.store.all());
    const selected = selectForStage(jobs, 'documents');
    if (selected.length === 0) {
      rt.logger.info(
        'No unapplied jobs are ready for documents yet (need a current career profile and cover letter, ' +
          'both written from the resume version the job classifies as).',
      );
      return;
    }

    const outRoot = process.env.SCRAPER_DOCS_OUTPUT_DIR || cfg.pipeline.documentsOutputDir;
    await mkdir(outRoot, { recursive: true });

    // Every run gets a brand-new timestamped batch folder rather than growing
    // the last one forever. The previous batch (if any) is only consulted as
    // a migration source: a still-open job (still selected for 'documents'
    // above) whose inputs haven't changed has its existing PDFs copied
    // across instead of rebuilt; a job that dropped out of selection since
    // then (applied, closed, or given an interview-stage outcome) is simply
    // not copied forward, so its company folder is left behind in the
    // previous batch and the new one never grows to include it.
    const previousBatchName = await findActiveBatch(outRoot);
    const previousIndex = previousBatchName
      ? await readIndex(join(outRoot, previousBatchName), batchRootWindows(cfg.pipeline.documentsOutputDir, previousBatchName))
      : null;

    const batch = newBatchName();
    const outBase = join(outRoot, batch);
    await mkdir(outBase, { recursive: true });
    const index = emptyIndex(batchRootWindows(cfg.pipeline.documentsOutputDir, batch));
    const folders: string[] = [];

    const toPdf = (docxName: string) => docxName.replace(/\.docx$/i, '.pdf');
    const manifest: Array<Record<string, unknown>> = [];
    const pending = new Map<string, { hash: string; folder: string; resume: string; coverLetter: string; title: string; company: string; version: string }>();
    let upToDate = 0;
    let migrated = 0;

    for (const job of selected) {
      const dj = toDocumentJob(job);
      const resumeDocId = resumeDocFor(dj.resumeVersion, cfg);
      const hash = inputsHash({
        company: dj.company,
        title: dj.title,
        careerProfile: dj.careerProfile,
        coverLetter: dj.coverLetter,
        resumeVersion: dj.resumeVersion,
        resumeDocId,
        relocationNote: dj.relocationNote,
        isInternational: dj.isInternational,
      });

      const prevEntry = previousIndex?.jobs[job.id];
      const prevFilesExist =
        previousBatchName !== null &&
        prevEntry !== undefined &&
        existsSync(join(outRoot, previousBatchName, prevEntry.folder, prevEntry.resume)) &&
        existsSync(join(outRoot, previousBatchName, prevEntry.folder, prevEntry.coverLetter));

      if (!opts.force && prevEntry && prevEntry.hash === hash && prevFilesExist) {
        // Unchanged since the previous batch and still open: carry the PDFs
        // forward by copying rather than paying for another LibreOffice run.
        const destFolder = join(outBase, prevEntry.folder);
        await mkdir(destFolder, { recursive: true });
        await copyFile(join(outRoot, previousBatchName as string, prevEntry.folder, prevEntry.resume), join(destFolder, prevEntry.resume));
        await copyFile(
          join(outRoot, previousBatchName as string, prevEntry.folder, prevEntry.coverLetter),
          join(destFolder, prevEntry.coverLetter),
        );
        index.jobs[job.id] = { ...prevEntry };
        if (!folders.some((f) => f.toLowerCase() === prevEntry.folder.toLowerCase())) folders.push(prevEntry.folder);
        upToDate++;
        migrated++;
        continue;
      }

      // Keep a job in the folder it already had; otherwise reuse the company's folder already placed in this batch, or start one.
      const folder = prevEntry?.folder ?? resolveCompanyFolder(folders, dj.company);
      if (!folders.some((f) => f.toLowerCase() === folder.toLowerCase())) folders.push(folder);
      const names = pickFileNames(
        index,
        job.id,
        folder,
        toPdf(buildResumeFileName(dj.title, dj.company)),
        toPdf(buildCoverLetterFileName(dj.title, dj.company)),
      );
      // Reserve the names now so two roles at one company in this same batch cannot collide either.
      index.jobs[job.id] = {
        company: dj.company,
        title: dj.title,
        folder,
        resume: names.resume,
        coverLetter: names.coverLetter,
        resumeVersion: dj.resumeVersion,
        hash: '',
        generatedAt: '',
      };
      pending.set(job.id, { hash, folder, resume: names.resume, coverLetter: names.coverLetter, title: dj.title, company: dj.company, version: dj.resumeVersion });

      manifest.push({
        id: job.id,
        company: dj.company,
        careerProfile: dj.careerProfile,
        coverLetter: dj.coverLetter,
        relocationNote: dj.relocationNote,
        isInternational: dj.isInternational,
        resumeDocId,
        outDir: join(outBase, folder),
        resumeFileName: names.resume.replace(/\.pdf$/i, '.docx'),
        coverLetterFileName: names.coverLetter.replace(/\.pdf$/i, '.docx'),
      });
    }

    if (manifest.length === 0) {
      await writeIndex(outBase, index);
      const folderCount = new Set(Object.values(index.jobs).map((e) => e.folder.toLowerCase())).size;
      rt.logger.info(
        `Documents: all ${upToDate} eligible job(s) already up to date — carried forward into new batch ${batch} ` +
          `(${folderCount} company folder(s)) under ${outRoot}. Nothing to build (--force rebuilds).` +
          (previousBatchName ? ` Previous batch ${previousBatchName} left as-is.` : ''),
      );
      return;
    }

    const manifestPath = resolve(cfg.pipeline.documentsManifestPath);
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const scriptPath = resolve('scripts/generate_documents.py');
    const proc = spawnSync('python3', [scriptPath, manifestPath], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (proc.error) {
      rt.logger.error(`Could not run generate_documents.py: ${proc.error.message}`);
      process.exitCode = 2;
      return;
    }
    if (proc.status !== 0) {
      rt.logger.error(`generate_documents.py exited ${proc.status}: ${proc.stderr}`);
      process.exitCode = 2;
      return;
    }

    let results: Array<{ id: string; ok: boolean; error?: string; warning?: string }>;
    try {
      results = JSON.parse(proc.stdout.trim().split('\n').pop() ?? '[]');
    } catch {
      rt.logger.error(`Could not parse generate_documents.py output: ${proc.stdout}`);
      process.exitCode = 2;
      return;
    }

    const now = new Date().toISOString();
    const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
    for (const [id, p] of pending) {
      if (okIds.has(id)) {
        index.jobs[id] = {
          company: p.company,
          title: p.title,
          folder: p.folder,
          resume: p.resume,
          coverLetter: p.coverLetter,
          resumeVersion: p.version as 'software-engineer' | 'test-analyst',
          hash: p.hash,
          generatedAt: now,
        };
      } else {
        delete index.jobs[id]; // failed to build in this fresh batch: leave no half-entry behind
      }
    }
    await writeIndex(outBase, index);

    const failed = results.filter((r) => !r.ok);
    const folderCount = new Set(Object.values(index.jobs).map((e) => e.folder.toLowerCase())).size;
    rt.logger.info(
      `Documents: ${okIds.size} job(s) built, ${migrated} carried forward unchanged, into ${folderCount} company ` +
        `folder(s) in new batch ${batch} under ${outRoot}, ${failed.length} failed.` +
        (previousBatchName ? ` Previous batch ${previousBatchName} left as-is (applied/closed jobs stay behind there).` : ''),
    );
    for (const f of failed.slice(0, 20)) {
      const j = selected.find((sel) => sel.id === f.id);
      rt.logger.warn(`Skipped ${j ? `${j.title} at ${j.company}` : f.id}: ${f.error}`);
    }
    for (const r of results.filter((x) => x.ok && x.warning).slice(0, 20)) {
      const j = selected.find((sel) => sel.id === r.id);
      rt.logger.warn(`${j ? `${j.title} at ${j.company}` : r.id}: ${r.warning}`);
    }
  });

/* -------------------------------------------------------- marking applied */

program
  .command('mark-applied [ids...]')
  .description(
    'Mark one or more jobs applied by id. With --note the text is stored as the job\'s applyNote, ' +
      'which sync-sheet shows in the Notes column and uses to tick the Applied checkbox in the Sheet ' +
      '(the apply skills pass --note "Applied by llm"). Manual escape hatch alongside sync-applied.',
  )
  .option('--from <file>', 'read ids from a text file, one per line, instead of/in addition to arguments')
  .option('--note <text>', 'record an applyNote on each job (marks it as applied by automation)')
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
      const res = rt.store.updateStatus(id, 'applied', { actor: opts.note ? 'apply-skill' : 'manual' });
      if (res.ok) {
        applied++;
        if (opts.note) rt.store.setApplyNote(id, String(opts.note));
      } else rt.logger.warn(`Skipped ${id}: ${res.reason}`);
    }
    await rt.store.save();
    rt.logger.info(`Marked ${applied} of ${allIds.length} job(s) applied.`);
  });

program
  .command('apply-note <id> <text...>')
  .description(
    'Record why the apply skills could not submit a job (for example "Q: <exact screening question>" or ' +
      '"External apply only"). The job stays unapplied but drops out of the apply queue until the note is ' +
      'cleared (--clear) or the queue is built with --retry. sync-sheet shows the note in the Notes column.',
  )
  .option('--clear', 'remove the note instead of setting it')
  .action(async (id: string, text: string[], opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();
    const res = rt.store.setApplyNote(id, opts.clear ? undefined : text.join(' '));
    if (!res.ok) {
      rt.logger.error(`Unknown job id ${id}.`);
      process.exitCode = 2;
      return;
    }
    await rt.store.save();
    rt.logger.info(opts.clear ? `Cleared the apply note on ${id}.` : `Recorded the apply note on ${id}.`);
  });

program
  .command('set-apply-method <id> <method>')
  .description(
    'Record how a job is applied to (easy_apply | quick_apply | external), once the apply skill has ' +
      'actually seen the listing and knows. Seek jobs already get this for free at scrape time from the ' +
      'listing\'s own isLinkOut flag; this command is for LinkedIn, which never exposes Easy Apply status ' +
      'to a logged-out scrape, so it can only be learned live. Once set, export-apply-queue never has to ' +
      'send that job back to a browser just to re-check.',
  )
  .action(async (id: string, method: string) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();
    if (method !== 'easy_apply' && method !== 'quick_apply' && method !== 'external') {
      rt.logger.error(`Unknown apply method "${method}". Must be one of: easy_apply, quick_apply, external.`);
      process.exitCode = 2;
      return;
    }
    const res = rt.store.setApplyMethod(id, method);
    if (!res.ok) {
      rt.logger.error(`Unknown job id ${id}.`);
      process.exitCode = 2;
      return;
    }
    await rt.store.save();
    rt.logger.info(`Recorded apply method "${method}" on ${id}.`);
  });

program
  .command('export-apply-queue')
  .description(
    'Write data/stage/apply-queue.json: the jobs ready to submit on LinkedIn (Easy Apply) or SEEK (Quick ' +
      'Apply), with tailored text and the exact resume / cover letter PDF paths from documents-index.json. ' +
      'Tracked, open jobs with a current profile and letter and PDFs on disk; jobs carrying an applyNote ' +
      '(an earlier attempt hit a wall) are left out unless --retry. No LLM involved.',
  )
  .option('--retry', 'include jobs that carry an applyNote')
  .option('-o, --out <path>', 'override pipeline.applyQueuePath')
  .action(async (opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);
    await rt.store.load();

    // Zero-LLM, zero-browser pre-pass: a job already known to be
    // applyMethod 'external' is never going to appear in the apply queue,
    // so record that now (same applyNote the apply skill would otherwise
    // have spent a browser visit discovering) rather than let it reach the
    // apply skill at all. Skips jobs that already carry a note (already
    // handled, one way or another) or aren't tracked to a platform.
    let autoExternal = 0;
    for (const job of dedupeById(rt.store.all())) {
      if (job.applyMethod !== 'external' || job.applyNote) continue;
      if (!platformOf(job.url)) continue;
      rt.store.setApplyNote(job.id, 'External apply only');
      autoExternal++;
    }
    if (autoExternal > 0) await rt.store.save();

    const outRoot = process.env.SCRAPER_DOCS_OUTPUT_DIR || cfg.pipeline.documentsOutputDir;
    const batch = await findActiveBatch(outRoot);
    const outBase = batch ? join(outRoot, batch) : outRoot;
    const rootWindows = batch ? batchRootWindows(cfg.pipeline.documentsOutputDir, batch) : cfg.pipeline.documentsOutputDir;
    const index = await readIndex(outBase, rootWindows);
    const queue = buildApplyQueue(dedupeById(rt.store.all()), index, {
      retry: Boolean(opts.retry),
      fileExists: (folder, file) => existsSync(join(outBase, folder, file)),
    });

    const outPath = resolve(opts.out ?? cfg.pipeline.applyQueuePath);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(queue, null, 2), 'utf8');
    rt.logger.info(
      `Apply queue: ${queue.counts.linkedin} LinkedIn, ${queue.counts.seek} SEEK written to ${outPath}` +
        (autoExternal > 0 ? `; ${autoExternal} skipped as external-apply-only (auto-detected, no browser visit needed)` : '') +
        (queue.missingDocuments > 0
          ? `; ${queue.missingDocuments} more are ready but have no PDFs yet (run generate-documents).`
          : '.'),
    );
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
      'By default syncs both the AU sheet (pipeline.trackerInboxPath) and the ' +
      'international one (pipeline.trackerInboxIntlPath). Pass --intl to sync only ' +
      'the international file/sheet.',
  )
  .option('--intl', 'sync only pipeline.trackerInboxIntlPath into pipeline.sheetsIntl (skip the AU pair)')
  .action(async (file: string | undefined, opts) => {
    const g = program.opts();
    const cfg = await loadConfig(resolve(g.config));
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);

    const syncOne = async (sheetsKey: 'sheets' | 'sheetsIntl', fileOverride?: string) => {
      const sheetsCfg = cfg.pipeline[sheetsKey];
      if (!sheetsCfg.spreadsheetId) {
        rt.logger.error(`pipeline.${sheetsKey}.spreadsheetId is not set in config.json. See docs/google-sheets-setup.md.`);
        process.exitCode = 2;
        return;
      }

      const inboxPath = resolve(
        fileOverride ?? (sheetsKey === 'sheetsIntl' ? cfg.pipeline.trackerInboxIntlPath : cfg.pipeline.trackerInboxPath),
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
        rt.logger.info(`[${sheetsKey}] No jobs in ${inboxPath} to append.`);
      } else {
        const result = await syncJobsToSheet(auth, sheetsCfg, jobs);
        for (const id of [...result.appended, ...result.alreadyPresent]) {
          const res = rt.store.updateStatus(id, 'tracked', { actor: 'sheet-sync' });
          if (res.ok) tracked++;
          else if (res.reason !== 'already tracked') skipped.push({ id, reason: res.reason });
        }
        rt.logger.info(
          `[${sheetsKey}] Sheet sync: ${result.appended.length} new row(s) added, ${result.alreadyPresent.length} already present. ` +
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
      // A text Anshu typed into the Sheet is his: stamp it as current for the
      // job's resume version so it is never re-queued as "drifted".
      for (const p of reconciled.profilePulledBack) {
        const j = jobsById.get(p.id);
        rt.store.setProfile(p.id, { careerProfile: p.careerProfile, version: j ? pickResumeVersion(j) : 'software-engineer' });
      }
      for (const c of reconciled.coverLetterPulledBack) {
        const j = jobsById.get(c.id);
        rt.store.setCoverLetter(c.id, { coverLetter: c.coverLetter, version: j ? pickResumeVersion(j) : 'software-engineer' });
      }
      // Runs after the pull-backs above so the snapshot always wins with what the cell really holds.
      for (const snap of reconciled.snapshots) rt.store.setSheetSnapshot(snap.id, snap);
      for (const id of reconciled.markedApplied) {
        rt.store.updateStatus(id, 'applied', { actor: 'sheet-sync' });
      }
      for (const stage of reconciled.interviewStages) {
        rt.store.setInterviewStage(stage.id, stage.stage);
      }
      await rt.store.save();

      if (reconciled.appliedPushError) {
        rt.logger.warn(
          `[${sheetsKey}] Could not tick the Applied checkbox for ${reconciled.appliedPushed.length || 'some'} job(s) ` +
            `applied by the apply skills: ${reconciled.appliedPushError}. They are still recorded as applied in jobs.json.`,
        );
      } else if (reconciled.appliedPushed.length > 0) {
        rt.logger.info(`[${sheetsKey}] Ticked Applied for ${reconciled.appliedPushed.length} job(s) applied by the apply skills.`);
      }

      const reconcileTotal =
        reconciled.appliedPushed.length +
        reconciled.profilePulledBack.length +
        reconciled.coverLetterPulledBack.length +
        reconciled.markedApplied.length +
        reconciled.interviewStages.length +
        reconciled.pushed.length;
      if (reconcileTotal > 0) {
        rt.logger.info(
          `[${sheetsKey}] Sheet reconcile: ${reconciled.pushed.length} cell(s) pushed, ` +
            `${reconciled.profilePulledBack.length} profile edit(s) and ${reconciled.coverLetterPulledBack.length} ` +
            `cover-letter edit(s) pulled back, ${reconciled.markedApplied.length} job(s) marked applied, ` +
            `${reconciled.interviewStages.length} interview stage(s) recorded.`,
        );
      }
    };

    if (opts.intl) {
      await syncOne('sheetsIntl', file);
    } else if (file) {
      // An explicit file override only makes sense against one sheet.
      await syncOne('sheets', file);
    } else {
      await syncOne('sheets');
      await syncOne('sheetsIntl');
    }
  });

program
  .command('new-tracker-tab')
  .description(
    'Rotate the tracker onto a fresh tab (duplicates the current tab, keeping its Table/dropdown/' +
      'formatting setup, clears its data rows, and points config.json\'s pipeline.sheets.sheetName ' +
      'at the new tab). By default rotates both the AU and international tracker tabs. Pass --intl ' +
      'to rotate only the international one (pipeline.sheetsIntl.sheetName).',
  )
  .option('--intl', 'rotate only the international tracker sheet (skip the AU one)')
  .action(async (opts) => {
    const g = program.opts();
    const configPath = resolve(g.config);
    const cfg = await loadConfig(configPath);
    const rt = makeRuntime(cfg, g.logLevel as LogLevel);

    const rotateOne = async (sheetsKey: 'sheets' | 'sheetsIntl') => {
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
    };

    if (opts.intl) {
      await rotateOne('sheetsIntl');
    } else {
      await rotateOne('sheets');
      await rotateOne('sheetsIntl');
    }
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

type Runtime = ReturnType<typeof makeRuntime>;

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
