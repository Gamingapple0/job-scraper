import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const SearchSchema = z.object({
  label: z.string().optional(),
  query: z.string(),
  location: z.string(),
  sources: z.array(z.string()).min(1),
  maxPages: z.number().int().positive().max(50).optional(),
  maxAgeDays: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});

const SourceSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    minDelayMs: z.number().int().nonnegative().default(1500),
    jitterMs: z.number().int().nonnegative().default(1500),
    maxRequestsPerRun: z.number().int().positive().default(200),
  })
  .passthrough(); // adapters read their own extra keys (endpoints, siteKey, ...)

export const ConfigSchema = z.object({
  /** Which PipelineProfile (src/core/profile.ts) this config runs under: 'main' or a variant such as 'christmas-casual'. */
  profile: z.string().default('main'),
  dataDir: z.string().default('./data'),
  userAgent: z
    .string()
    .default(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ),
  cache: z
    .object({
      enabled: z.boolean().default(true),
      ttlMinutes: z.number().int().nonnegative().default(360),
    })
    .default({}),
  defaults: z
    .object({
      maxPages: z.number().int().positive().default(5),
      maxAgeDays: z.number().int().positive().default(30),
      fetchDetail: z.boolean().default(false),
      closeAfterMissedRuns: z.number().int().positive().default(3),
      fuzzyDedupe: z.boolean().default(true),
      /** Fail a source's run if it returns less than this fraction of its recent average. */
      sanityFloorRatio: z.number().min(0).max(1).default(0.2),
    })
    .default({}),
  sources: z.record(SourceSettingsSchema).default({}),
  searches: z.array(SearchSchema).default([]),
  /** Paths and cutoffs for the downstream-agent handoff files. See README. */
  pipeline: z
    .object({
      fitInboxPath: z.string().default('./data/stage/fit-filter-inbox.json'),
      trackerInboxPath: z.string().default('./data/stage/tracker-inbox.json'),
      /** Same as trackerInboxPath but for jobs whose location.country isn't AU. */
      trackerInboxIntlPath: z.string().default('./data/stage/tracker-inbox-intl.json'),
      profileInboxPath: z.string().default('./data/stage/profile-inbox.json'),
      coverLetterInboxPath: z.string().default('./data/stage/cover-letter-inbox.json'),
      /** Combined career-profile + cover-letter inbox (one record per job, JD once). */
      materialsInboxPath: z.string().default('./data/stage/materials-inbox.json'),
      /** Ready-to-submit work list for the LinkedIn / SEEK apply skills. */
      applyQueuePath: z.string().default('./data/stage/apply-queue.json'),
      /**
       * Where `generate-documents` writes its per-job manifest before
       * handing off to the Python/LibreOffice conversion step. Not an LLM
       * inbox — nothing reads this but that one script.
       */
      documentsManifestPath: z.string().default('./data/stage/documents-manifest.json'),
      /**
       * Root folder `generate-documents` writes into: one subfolder per
       * company (created on first use, reused after that) plus
       * documents-index.json. Overridable via
       * the SCRAPER_DOCS_OUTPUT_DIR environment variable — needed because
       * this same command runs in two different places: natively on
       * Windows (where this absolute path is correct as-is) and inside
       * the Claude Cowork device_bash Linux sandbox (where the connected
       * folder is mounted elsewhere, e.g. "$HOME/mnt/Documents/Resumes
       * Gen" — export SCRAPER_DOCS_OUTPUT_DIR to that path before invoking
       * the command there).
       */
      documentsOutputDir: z.string().default('C:\\Users\\madhi\\OneDrive\\Documents\\Resumes Gen'),
      /**
       * Google Doc ids for the two base resume documents (File > Share >
       * "Anyone with the link" required, since generate-documents fetches
       * them by anonymous export). Anshu edits these directly in Google
       * Docs (Employment/Education/Technical Skills) — the Career Profile
       * paragraph is the only part generate-documents overwrites.
       */
      documentsResumeDocs: z
        .object({
          softwareEngineer: z.string().default('1Ckp91JCvQGZFhrkzc-lgzIMyqauBF8b4ShjOdS2N2dw'),
          testAnalyst: z.string().default('15gKsst2OHNSaGPsYbtqUIbpKRS6M2ptet7uMdllp5KI'),
          /** Only read by the christmas-casual profile. */
          christmasCasual: z.string().default(''),
        })
        .default({}),
      /** Don't send a listing to the (token-costing) fit-filter agent once
       * it's older than this, even if still pipelineStatus 'scraped'. */
      fitInboxMaxAgeDays: z.number().int().positive().default(14),
      /** Google Sheets sync target for `sync-sheet`. See docs/google-sheets-setup.md. */
      sheets: z
        .object({
          spreadsheetId: z.string().default(''),
          sheetName: z.string().default('Tracker'),
          oauthClientPath: z.string().default('./config/google-oauth-client.json'),
          oauthTokenPath: z.string().default('./config/google-oauth-token.json'),
          /** Adds a Country column after Location. Off for the AU tracker — every AU job is AU. */
          includeCountry: z.boolean().default(false),
        })
        .default({}),
      /**
       * Same shape as `sheets`, for jobs whose location.country isn't AU —
       * kept as a separate spreadsheet so the AU tracker doesn't get
       * crowded out. Reuses the same OAuth client/token by default since
       * it's the same Google account either way; only spreadsheetId (and
       * usually sheetName, once the tab is set up) need to differ.
       */
      sheetsIntl: z
        .object({
          spreadsheetId: z.string().default(''),
          sheetName: z.string().default('Tracker'),
          oauthClientPath: z.string().default('./config/google-oauth-client.json'),
          oauthTokenPath: z.string().default('./config/google-oauth-token.json'),
          /** International jobs span many countries, so this tracker gets a Country column. */
          includeCountry: z.boolean().default(true),
        })
        .default({}),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type SearchConfig = z.infer<typeof SearchSchema>;

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Config not found at ${path}. Copy config/config.example.json to config/config.json.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`Config at ${path} is not valid JSON: ${String(err)}`);
  }

  // Gitignored per-machine overrides (real spreadsheet IDs, etc.) layered on
  // top of the committed config. See config/config.local.json.example.
  const localPath = path.replace(/\.json$/, '.local.json');
  try {
    const localText = await readFile(localPath, 'utf8');
    json = deepMerge(json, JSON.parse(localText));
  } catch {
    // No local override file — config.json alone is used.
  }

  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Config at ${path} is invalid:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursively merges `override` onto `base`; anything else (arrays, scalars) replaces wholesale. */
function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const result: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) result[k] = deepMerge(result[k], v);
  return result;
}
