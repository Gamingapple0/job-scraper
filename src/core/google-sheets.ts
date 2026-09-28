import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:http';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { sheets, type sheets_v4 } from '@googleapis/sheets';
import type { CleanJob } from './stage-export.js';
import type { ApplyMethod, Job } from './types.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

/**
 * "Desktop app" OAuth clients from Google Cloud Console register a bare
 * `http://localhost` (no port) as their redirect URI. Google's loopback flow
 * (RFC 8252) for this client type accepts ANY port appended to that at
 * request time, even though it isn't an exact string match to what's
 * registered — so we pick a fixed one ourselves and use it consistently for
 * both the auth request and the local server that catches the redirect.
 * (Using the bare, port-less URI for the auth request — which is what a
 * naive `redirect_uris[0]` lookup gives you — makes Google redirect to port
 * 80 with nothing listening there: "localhost refused to connect".)
 */
const DEFAULT_LOOPBACK_PORT = 53682;

/**
 * The header row written to a fresh tab, and read back by every function
 * below to find columns by name (never by a hardcoded index) — so this one
 * array is the single source of truth for both the column order and which
 * columns exist. `includeCountry` (SheetsConfig) adds a Country column
 * right after Location: only the international tracker sets it, since only
 * LinkedIn results span more than one country (see SheetsConfig.includeCountry).
 */
export function sheetHeaders(cfg: SheetsConfig): string[] {
  return [
    'Job ID',
    'Title',
    'Company',
    'Location',
    ...(cfg.includeCountry ? ['Country'] : []),
    'URL',
    'Applied/Closed',
    'Career Profile',
    'Cover Letter',
    'Fit Reason',
    'Date Added',
    'Date Posted',
    'Tags',
    'Salary',
    'Notes',
    'Stages',
    'Apply Method',
  ];
}

/** Anshu's own outcome-tracking dropdown for the Stages column. */
/**
 * Tracker label for each ApplyMethod. Blank means not known yet: SEEK jobs
 * get it at scrape time, LinkedIn jobs only once the apply skill has opened
 * the listing and run set-apply-method.
 */
export const APPLY_METHOD_LABELS: Record<ApplyMethod, string> = {
  easy_apply: 'Easy Apply',
  quick_apply: 'Quick Apply',
  external: 'External',
};

export function applyMethodLabel(method: ApplyMethod | undefined): string {
  return method ? APPLY_METHOD_LABELS[method] : '';
}

export const STAGE_OPTIONS = ['Take home', 'Initial Screen', 'Final Round', 'Offer', 'NA', 'Invalid'] as const;

/**
 * Column offsets, looked up by header name rather than hardcoded — so
 * reordering `sheetHeaders` above is the only place a layout change ever
 * has to happen. `country` is -1 on a layout without one (the AU tracker);
 * every caller that reads it already only does so when `includeCountry`.
 */
interface ColIndex {
  jobId: number;
  location: number;
  country: number;
  url: number;
  applied: number;
  careerProfile: number;
  coverLetter: number;
  fitReason: number;
  dateAdded: number;
  datePosted: number;
  tags: number;
  salary: number;
  notes: number;
  stages: number;
  applyMethod: number;
}

export function colIndex(headers: string[]): ColIndex {
  const at = (name: string) => headers.indexOf(name);
  return {
    jobId: at('Job ID'),
    location: at('Location'),
    country: at('Country'),
    url: at('URL'),
    applied: at('Applied/Closed'),
    careerProfile: at('Career Profile'),
    coverLetter: at('Cover Letter'),
    fitReason: at('Fit Reason'),
    dateAdded: at('Date Added'),
    datePosted: at('Date Posted'),
    tags: at('Tags'),
    salary: at('Salary'),
    notes: at('Notes'),
    stages: at('Stages'),
    applyMethod: at('Apply Method'),
  };
}

/** 0-indexed column number -> A1 letter (0 -> 'A', 11 -> 'L', ...). Only needs single-letter range in this sheet's size. */
function columnLetter(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

/** Last column letter for the full-width A1 ranges below, derived from how many columns this layout has. */
function lastColumnLetter(headers: string[]): string {
  return columnLetter(headers.length - 1);
}

export interface SheetsConfig {
  spreadsheetId: string;
  sheetName: string;
  oauthClientPath: string;
  oauthTokenPath: string;
  /** Adds a Country column after Location — set for the international tracker only. */
  includeCountry?: boolean;
}

interface OAuthClientFile {
  installed?: { client_id: string; client_secret: string; redirect_uris: string[] };
  web?: { client_id: string; client_secret: string; redirect_uris: string[] };
}

function setupHelpMessage(oauthClientPath: string): string {
  return `No OAuth client file at ${oauthClientPath}. See docs/google-sheets-setup.md to create one (one-time, ~10 minutes).`;
}

async function loadOAuthClient(cfg: SheetsConfig): Promise<OAuth2Client> {
  let raw: string;
  try {
    raw = await readFile(resolve(cfg.oauthClientPath), 'utf8');
  } catch {
    throw new Error(setupHelpMessage(cfg.oauthClientPath));
  }
  const parsed = JSON.parse(raw) as OAuthClientFile;
  const creds = parsed.installed ?? parsed.web;
  if (!creds) {
    throw new Error(`${cfg.oauthClientPath} does not look like a Google OAuth client JSON (no "installed" or "web" key).`);
  }
  const redirectUri = pickLoopbackRedirectUri(creds.redirect_uris);
  return new OAuth2Client({ clientId: creds.client_id, clientSecret: creds.client_secret, redirectUri });
}

function loopbackHostname(u: string): string | undefined {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' ? h : undefined;
  } catch {
    return undefined;
  }
}

/** See the DEFAULT_LOOPBACK_PORT comment above for why this isn't a plain lookup. */
function pickLoopbackRedirectUri(redirectUris: string[]): string {
  const withExplicitPort = redirectUris.find((u) => loopbackHostname(u) && new URL(u).port);
  if (withExplicitPort) return withExplicitPort;

  const bareLoopback = redirectUris.find((u) => loopbackHostname(u));
  if (bareLoopback) {
    const url = new URL(bareLoopback);
    url.port = String(DEFAULT_LOOPBACK_PORT);
    return url.toString();
  }

  throw new Error(
    `No localhost/127.0.0.1 redirect URI found among: ${redirectUris.join(', ')}. ` +
      'Create the OAuth client as a "Desktop app" type — see docs/google-sheets-setup.md.',
  );
}

async function persistTokens(tokenPath: string, tokens: Credentials): Promise<void> {
  const path = resolve(tokenPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(tokens, null, 2), 'utf8');
}

/**
 * Loads the saved OAuth token and wires the client to persist any refreshed
 * access token back to disk. Throws with a clear instruction if no token has
 * been saved yet — that's what `npm run google-auth` (see runInteractiveAuth
 * below) is for, and it's meant to be run once, by hand, ahead of time.
 */
export async function getAuthorizedClient(cfg: SheetsConfig): Promise<OAuth2Client> {
  const client = await loadOAuthClient(cfg);
  let tokenRaw: string;
  try {
    tokenRaw = await readFile(resolve(cfg.oauthTokenPath), 'utf8');
  } catch {
    throw new Error(
      `No saved Google auth token at ${cfg.oauthTokenPath}. Run "npm run google-auth" once to authorize this app, then re-run this command.`,
    );
  }
  client.setCredentials(JSON.parse(tokenRaw) as Credentials);
  client.on('tokens', (tokens) => {
    void persistTokens(cfg.oauthTokenPath, { ...client.credentials, ...tokens });
  });
  return client;
}

/**
 * One-time interactive setup, meant to be run by hand (`npm run google-auth`),
 * never from the scheduled/unattended pipeline. Prints a consent URL, opens a
 * throwaway local HTTP server to catch Google's redirect, exchanges the code
 * for tokens, and saves them to oauthTokenPath. After this, sync-sheet needs
 * no further interaction.
 */
export async function runInteractiveAuth(cfg: SheetsConfig): Promise<void> {
  const client = await loadOAuthClient(cfg);
  const redirectUri = new URL((client as unknown as { redirectUri: string }).redirectUri ?? 'http://localhost:53682/oauth2callback');
  const port = Number(redirectUri.port || 53682);

  const authUrl = client.generateAuthUrl({
    access_type: 'offline', // required to get a refresh_token
    prompt: 'consent', // force a refresh_token even on repeat runs
    scope: SCOPES,
  });

  console.log('\nOpen this URL in a browser and sign in with the Google account that owns/edits the tracker Sheet:\n');
  console.log(authUrl);
  console.log(`\nWaiting for the redirect back to ${redirectUri.origin}${redirectUri.pathname} ...\n`);

  const code = await new Promise<string>((promiseResolve, promiseReject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== redirectUri.pathname) {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const authCode = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (err || !authCode) {
        res.end(`<html><body>Authorization failed: ${err ?? 'no code returned'}. You can close this tab.</body></html>`);
        server.close();
        promiseReject(new Error(`OAuth failed: ${err ?? 'no code returned'}`));
        return;
      }
      res.end('<html><body>Authorized. You can close this tab and return to the terminal.</body></html>');
      server.close();
      promiseResolve(authCode);
    });
    server.listen(port);
  });

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke this app\'s access at https://myaccount.google.com/permissions and re-run "npm run google-auth" so it can prompt for consent again.',
    );
  }
  await persistTokens(cfg.oauthTokenPath, tokens);
  console.log(`Saved token to ${cfg.oauthTokenPath}. sync-sheet can now run unattended.`);
}

function sheetsClient(auth: OAuth2Client): sheets_v4.Sheets {
  return sheets({ version: 'v4', auth });
}

/** True row-and-column-A1 range for the configured tab, e.g. "'Tracker'!A:K". */
function tabRange(sheetName: string, suffix: string): string {
  return `'${sheetName.replace(/'/g, "''")}'!${suffix}`;
}

/**
 * Confirms the target tab exists in the spreadsheet — creating it if not —
 * and that its header row has at least this config's header count,
 * extending it in place (non-destructively) if it's short. Every function
 * below that touches the sheet calls this first: it's cheap (one metadata
 * read) and it means a tab renamed or trimmed by hand doesn't produce a
 * cryptic "Unable to parse range" from deep inside a values.get call —
 * it's caught here with the actual list of tabs that DO exist.
 */
async function ensureSheetAndHeader(client: sheets_v4.Sheets, cfg: SheetsConfig): Promise<string[]> {
  const headers = sheetHeaders(cfg);
  const meta = await client.spreadsheets.get({ spreadsheetId: cfg.spreadsheetId });
  const titles = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? '(untitled)');
  const existingTab = meta.data.sheets?.find((s) => s.properties?.title === cfg.sheetName);

  let freshSheetId: number | undefined;
  if (!existingTab) {
    if (titles.length > 0) {
      throw new Error(
        `No tab named "${cfg.sheetName}" in this spreadsheet (pipeline.sheets.sheetName in config/config.json). ` +
          `Tabs found: ${titles.join(', ')}. Fix the config, or rename the tab back to "${cfg.sheetName}".`,
      );
    }
    const created = await client.spreadsheets.batchUpdate({
      spreadsheetId: cfg.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: cfg.sheetName } } }] },
    });
    freshSheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId ?? undefined;
  }

  const header = await client.spreadsheets.values.get({
    spreadsheetId: cfg.spreadsheetId,
    range: tabRange(cfg.sheetName, '1:1'),
  });
  const headerRow = header.data.values?.[0] ?? [];

  if (headerRow.length < headers.length) {
    await client.spreadsheets.values.update({
      spreadsheetId: cfg.spreadsheetId,
      range: tabRange(cfg.sheetName, `${columnLetter(headerRow.length)}1`),
      valueInputOption: 'RAW',
      requestBody: { values: [headers.slice(headerRow.length)] },
    });
  }

  if (freshSheetId !== undefined) await applyReadabilityFormatting(client, cfg, freshSheetId, headers);
  return headers;
}

/**
 * Freeze + bold the header row, wrap the long free-text columns, and narrow
 * the columns nobody reads at a glance (Job ID, URL). Applied once, right
 * after the tab is created — re-running it on every sync would be wasted
 * API calls and would fight any manual formatting tweak Anshu makes
 * afterward.
 */
async function applyReadabilityFormatting(
  client: sheets_v4.Sheets,
  cfg: SheetsConfig,
  sheetId: number,
  headers: string[],
): Promise<void> {
  const col = colIndex(headers);
  const lastRow = 5000; // generous fixed bound; cheap and avoids a row-count lookup
  const wrapColumns = [col.careerProfile, col.coverLetter, col.notes];

  await client.spreadsheets.batchUpdate({
    spreadsheetId: cfg.spreadsheetId,
    requestBody: {
      requests: [
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: 'WRAP' } },
            fields: 'userEnteredFormat(textFormat.bold,wrapStrategy)',
          },
        },
        ...wrapColumns.map((col2) => ({
          repeatCell: {
            range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: col2, endColumnIndex: col2 + 1 },
            cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
            fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)',
          },
        })),
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: col.jobId, endIndex: col.jobId + 1 },
            properties: { pixelSize: 90 },
            fields: 'pixelSize',
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: col.url, endIndex: col.url + 1 },
            properties: { pixelSize: 80 },
            fields: 'pixelSize',
          },
        },
        ...wrapColumns.map((col2) => ({
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: col2, endIndex: col2 + 1 },
            properties: { pixelSize: 280 },
            fields: 'pixelSize',
          },
        })),
        // No setDataValidation requests here on purpose: this sheet is a
        // Google Sheets "Table" (see the tab's `tables[]` metadata), which
        // owns Applied/Closed as a BOOLEAN typed column and Stages as a
        // DROPDOWN typed column with STAGE_OPTIONS as its values already —
        // the classic data-validation API refuses writes to a Table's typed
        // columns ("not allowed on cells in typed columns"), and there's
        // nothing to add here that the Table isn't already doing natively.
      ],
    },
  });
}

export interface NewTabResult {
  oldTab: string;
  newTab: string;
}

/**
 * "Tracker" -> "Tracker 2"; "Tracker 2" -> "Tracker 3"; skips any name
 * already taken (e.g. one created by hand or a previous rotation).
 */
function nextTabName(currentName: string, existingTitles: string[]): string {
  const base = currentName.replace(/\s+\d+$/, '');
  const taken = new Set(existingTitles);
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/**
 * Rotates the tracker onto a fresh tab when the current one gets too long
 * to work with. Duplicates the tab via Sheets' own duplicateSheet request
 * rather than rebuilding it cell-by-cell — that's what carries over the
 * Table's typed Applied/Closed (BOOLEAN) and Stages (DROPDOWN) columns plus
 * all formatting, none of which the plain data-validation API can (re)create
 * (see the comment in applyReadabilityFormatting). Then clears every data
 * row the duplicate copied over, leaving just the header and the Table
 * setup. Deterministic, no LLM — the caller (the `new-tracker-tab` CLI
 * command) is responsible for pointing config.json's sheetName at the
 * result so every subsequent sync-sheet targets the fresh tab.
 */
export async function startNewTrackerTab(auth: OAuth2Client, cfg: SheetsConfig): Promise<NewTabResult> {
  const client = sheetsClient(auth);
  const headers = await ensureSheetAndHeader(client, cfg);

  const meta = await client.spreadsheets.get({ spreadsheetId: cfg.spreadsheetId });
  const allSheets = meta.data.sheets ?? [];
  const current = allSheets.find((s) => s.properties?.title === cfg.sheetName);
  const sourceSheetId = current?.properties?.sheetId;
  if (sourceSheetId == null) throw new Error(`Could not resolve sheetId for tab "${cfg.sheetName}".`);

  const newName = nextTabName(
    cfg.sheetName,
    allSheets.map((s) => s.properties?.title ?? ''),
  );

  const dup = await client.spreadsheets.batchUpdate({
    spreadsheetId: cfg.spreadsheetId,
    requestBody: {
      requests: [
        {
          duplicateSheet: {
            sourceSheetId,
            insertSheetIndex: (current?.properties?.index ?? 0) + 1,
            newSheetName: newName,
          },
        },
      ],
    },
  });
  const newSheetId = dup.data.replies?.[0]?.duplicateSheet?.properties?.sheetId;
  if (newSheetId == null) throw new Error('duplicateSheet did not return a new sheetId.');

  // Wipe every data row the duplicate copied over — keep the header and
  // whatever Table/formatting setup came along with it.
  await client.spreadsheets.values.clear({
    spreadsheetId: cfg.spreadsheetId,
    range: tabRange(newName, `A2:${lastColumnLetter(headers)}`),
  });

  return { oldTab: cfg.sheetName, newTab: newName };
}

/** Job IDs already present in column A, so the caller can skip jobs already
 *  synced without ever re-checking with an LLM. Call ensureSheetAndHeader
 *  first — this assumes the tab already exists. */
async function getExistingIds(client: sheets_v4.Sheets, cfg: SheetsConfig): Promise<Set<string>> {
  const colA = await client.spreadsheets.values.get({
    spreadsheetId: cfg.spreadsheetId,
    range: tabRange(cfg.sheetName, 'A:A'),
  });
  const rows = colA.data.values ?? [];
  // Row 1 is the header (ensureSheetAndHeader guarantees it exists by now) —
  // every row after it starts with a Job ID.
  const ids = rows.slice(1).map((r) => String(r[0] ?? '')).filter(Boolean);
  return new Set(ids);
}

export function jobToRow(job: CleanJob, dateAdded: string, headers: string[]): (string | number)[] {
  const cell: Record<string, string> = {
    'Job ID': job.id,
    Title: job.title,
    Company: job.company,
    Location: job.location,
    Country: job.country ?? '',
    URL: job.url,
    'Applied/Closed': '', // a checkbox Anshu ticks himself; sync-sheet reads it back, never writes it
    'Career Profile': '', // filled in later by reconcileSheetColumns, never at append time
    'Cover Letter': '', // filled in later, once the career-profile agent has run
    'Fit Reason': job.fitReason ?? '',
    'Date Added': dateAdded,
    'Date Posted': job.postedAt ?? '',
    Tags: job.tags.join(', '),
    Salary: job.salary ?? '',
    Notes: '',
    Stages: '', // Anshu's own manual dropdown; sync-sheet reads it back, never writes it
    'Apply Method': applyMethodLabel(job.applyMethod),
  };
  return headers.map((h) => cell[h] ?? '');
}

export interface SyncResult {
  appended: string[]; // job ids newly written to the sheet
  alreadyPresent: string[]; // job ids that were already in the sheet (no-op, still safe to mark tracked)
}

/**
 * Deterministic, idempotent sync: appends every job not already present
 * (matched by Job ID in column A) as a new row, and creates the header row
 * on first use. No LLM involved — this only ever moves CleanJob fields into
 * cells. The caller (sync-sheet in cli.ts) decides what to do with the
 * result, e.g. advancing pipelineStatus to 'tracked'.
 */
export async function syncJobsToSheet(auth: OAuth2Client, cfg: SheetsConfig, jobs: CleanJob[]): Promise<SyncResult> {
  const client = sheetsClient(auth);
  const headers = await ensureSheetAndHeader(client, cfg);
  const existingIds = await getExistingIds(client, cfg);

  const toAppend = jobs.filter((j) => !existingIds.has(j.id));
  const alreadyPresent = jobs.filter((j) => existingIds.has(j.id)).map((j) => j.id);

  if (toAppend.length > 0) {
    const now = new Date().toISOString().slice(0, 10);
    await client.spreadsheets.values.append({
      spreadsheetId: cfg.spreadsheetId,
      range: tabRange(cfg.sheetName, `A:${lastColumnLetter(headers)}`),
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toAppend.map((j) => jobToRow(j, now, headers)) },
    });
  }

  return { appended: toAppend.map((j) => j.id), alreadyPresent };
}

export interface SheetReconcileResult {
  /** Jobs where the Sheet already had a Career Profile Anshu typed in by
   *  hand — pulled back so jobs.json matches and export-profile-inbox never
   *  sends these to the LLM step again. */
  profilePulledBack: Array<{ id: string; careerProfile: string }>;
  /** Same idea, for a Cover Letter Anshu typed in by hand. */
  coverLetterPulledBack: Array<{ id: string; coverLetter: string }>;
  /** Job ids whose Applied checkbox is ticked but pipelineStatus isn't
   *  'applied' yet — the caller advances these through updateStatus(). */
  markedApplied: string[];
  /** Job ids with a non-blank Stages cell not yet reflected in jobs.json —
   *  the caller writes these through setInterviewStage(). Once set, this
   *  is what stops selectForStage from sending the job to any agent again. */
  interviewStages: Array<{ id: string; stage: string }>;
  pushed: string[]; // job ids whose computed profile/cover-letter/note was written into the Sheet
  /** What each Career Profile / Cover Letter cell holds after this reconcile; the caller stores it via setSheetSnapshot. */
  snapshots: Array<{ id: string; careerProfile?: string; coverLetter?: string }>;
  /** Job ids whose Applied checkbox was ticked from jobs.json (applied by the apply skills, not by hand in the Sheet). */
  appliedPushed: string[];
  /** Set when that tick could not be written (e.g. the Table's typed checkbox column refused it). Never fails the sync. */
  appliedPushError?: string;
}

export type CellAction = 'none' | 'push' | 'pull';

/**
 * Which way a text cell (Career Profile / Cover Letter) should move.
 *
 * - Sheet empty: push whatever jobs.json has.
 * - Same text: nothing to do.
 * - Different, and the sheet still holds exactly what we last saw there
 *   (`snapshot`): jobs.json was regenerated and the cell is stale, so push.
 *   Without this rule a regenerated profile is overwritten by its own old
 *   cell on the very next sync.
 * - Different, and the sheet has changed since we last saw it (or we never
 *   recorded a snapshot): Anshu typed there, his edit wins, pull it back.
 */
export function decideTextCell(jobValue: string | undefined, sheetValue: string, snapshot: string | undefined): CellAction {
  const job = (jobValue ?? '').trim();
  const sheet = sheetValue.trim();
  if (!sheet) return job ? 'push' : 'none';
  if (job === sheet) return 'none';
  if (job && snapshot !== undefined && sheet === snapshot.trim()) return 'push';
  return 'pull';
}

/**
 * Two-way, no-LLM reconciliation of every editable column on the sheet:
 * Career Profile / Cover Letter / Notes push or pull depending on which
 * side has content (a non-empty cell Anshu typed by hand always wins and
 * is pulled back; otherwise whatever jobs.json has gets pushed). Applied
 * and Stages are pull-only — Anshu is the only writer of those two
 * columns, this only ever reads them back into jobs.json (via the
 * caller's updateStatus/setInterviewStage) so that a manual tick or
 * dropdown pick takes every downstream agent off that job's case on the
 * very next run. Nothing here calls an LLM.
 */
export async function reconcileSheetColumns(
  auth: OAuth2Client,
  cfg: SheetsConfig,
  jobsById: Map<string, Job>,
): Promise<SheetReconcileResult> {
  const client = sheetsClient(auth);
  const headers = await ensureSheetAndHeader(client, cfg);
  const col = colIndex(headers);
  const res = await client.spreadsheets.values.get({
    spreadsheetId: cfg.spreadsheetId,
    range: tabRange(cfg.sheetName, `A:${lastColumnLetter(headers)}`),
  });
  const rows = res.data.values ?? [];

  const profilePulledBack: SheetReconcileResult['profilePulledBack'] = [];
  const coverLetterPulledBack: SheetReconcileResult['coverLetterPulledBack'] = [];
  const markedApplied: string[] = [];
  const interviewStages: SheetReconcileResult['interviewStages'] = [];
  const pushed: string[] = [];
  const snapshots: SheetReconcileResult['snapshots'] = [];
  const appliedWrites: sheets_v4.Schema$ValueRange[] = [];
  const appliedPushed: string[] = [];
  const writes: sheets_v4.Schema$ValueRange[] = [];

  // rows[0] is the header; sheet rows are 1-indexed, so data row i (0-based
  // into `rows`, i >= 1) sits at sheet row i + 1.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const id = String(row[col.jobId] ?? '');
    if (!id) continue;
    const job = jobsById.get(id);
    if (!job) continue; // row for a job no longer in jobs.json — leave it alone

    const sheetRowNum = i + 1;

    // --- Career Profile / Cover Letter (see decideTextCell for the rule) ---
    const snapshot: { id: string; careerProfile?: string; coverLetter?: string } = { id };

    const sheetProfile = String(row[col.careerProfile] ?? '').trim();
    const profileAction = decideTextCell(job.careerProfile, sheetProfile, job.sheetCareerProfile);
    if (profileAction === 'pull') {
      profilePulledBack.push({ id, careerProfile: sheetProfile });
      snapshot.careerProfile = sheetProfile;
    } else if (profileAction === 'push') {
      const text = (job.careerProfile ?? '').trim();
      writes.push({ range: tabRange(cfg.sheetName, `${columnLetter(col.careerProfile)}${sheetRowNum}`), values: [[text]] });
      pushed.push(id);
      snapshot.careerProfile = text;
    } else if (sheetProfile) {
      snapshot.careerProfile = sheetProfile;
    }

    const sheetCoverLetter = String(row[col.coverLetter] ?? '').trim();
    const letterAction = decideTextCell(job.coverLetter, sheetCoverLetter, job.sheetCoverLetter);
    if (letterAction === 'pull') {
      coverLetterPulledBack.push({ id, coverLetter: sheetCoverLetter });
      snapshot.coverLetter = sheetCoverLetter;
    } else if (letterAction === 'push') {
      const text = (job.coverLetter ?? '').trim();
      writes.push({ range: tabRange(cfg.sheetName, `${columnLetter(col.coverLetter)}${sheetRowNum}`), values: [[text]] });
      pushed.push(id);
      snapshot.coverLetter = text;
    } else if (sheetCoverLetter) {
      snapshot.coverLetter = sheetCoverLetter;
    }
    if (snapshot.careerProfile !== undefined || snapshot.coverLetter !== undefined) snapshots.push(snapshot);

    // --- Notes: reflects whichever agent-side note (if any) is pending ---
    const desiredNote = job.profileNote ?? job.coverLetterNote ?? job.applyNote ?? '';
    const currentNote = String(row[col.notes] ?? '').trim();
    if (desiredNote !== currentNote) {
      writes.push({
        range: tabRange(cfg.sheetName, `${columnLetter(col.notes)}${sheetRowNum}`),
        values: [[desiredNote]],
      });
      pushed.push(id);
    }

    // --- Apply Method: push-only, jobs.json is the only source (set at scrape time or by set-apply-method) ---
    if (col.applyMethod >= 0) {
      const desiredMethod = applyMethodLabel(job.applyMethod);
      const currentMethod = String(row[col.applyMethod] ?? '').trim();
      if (desiredMethod && desiredMethod !== currentMethod) {
        writes.push({
          range: tabRange(cfg.sheetName, `${columnLetter(col.applyMethod)}${sheetRowNum}`),
          values: [[desiredMethod]],
        });
        pushed.push(id);
      }
    }

    // --- Applied checkbox: pull-back only, Anshu is the only writer ---
    const appliedCell = row[col.applied];
    const appliedChecked = appliedCell === true || /^(true|yes|1)$/i.test(String(appliedCell ?? ''));
    if (appliedChecked && job.pipelineStatus !== 'applied') {
      markedApplied.push(id);
    }
    // The one push: a job the apply skills submitted (applyNote is set only by
    // them or by mark-applied --note) gets its checkbox ticked here, so the
    // skills never have to drive the Sheet UI. A plain manual mark-applied
    // carries no applyNote and is left alone.
    if (!appliedChecked && job.pipelineStatus === 'applied' && job.applyNote && col.applied >= 0) {
      appliedWrites.push({ range: tabRange(cfg.sheetName, `${columnLetter(col.applied)}${sheetRowNum}`), values: [[true]] });
      appliedPushed.push(id);
    }

    // --- Stages: pull-back only, Anshu is the only writer ---
    const sheetStage = String(row[col.stages] ?? '').trim();
    if (sheetStage && job.interviewStage !== sheetStage) {
      interviewStages.push({ id, stage: sheetStage });
    }
  }

  if (writes.length > 0) {
    await client.spreadsheets.values.batchUpdate({
      spreadsheetId: cfg.spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: writes },
    });
  }

  // Separate from the text writes above so a refusal from the Table's typed
  // checkbox column can never take the profile/cover-letter push down with it.
  let appliedPushError: string | undefined;
  if (appliedWrites.length > 0) {
    try {
      await client.spreadsheets.values.batchUpdate({
        spreadsheetId: cfg.spreadsheetId,
        requestBody: { valueInputOption: 'USER_ENTERED', data: appliedWrites },
      });
    } catch (err) {
      appliedPushError = String(err);
      appliedPushed.length = 0;
    }
  }

  return { profilePulledBack, coverLetterPulledBack, markedApplied, interviewStages, pushed, snapshots, appliedPushed, appliedPushError };
}
