import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:http';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { sheets, type sheets_v4 } from '@googleapis/sheets';
import type { CleanJob } from './stage-export.js';
import type { Job } from './types.js';

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

/** The header row written to a fresh tab. Order here is the column order. */
export const SHEET_HEADERS = [
  'Job ID',
  'Title',
  'Company',
  'Location',
  'Posted',
  'Salary',
  'Tags',
  'Fit Reason',
  'URL',
  'Date Added',
  'Applied',
  'Career Profile',
  'Technical Skills',
  'Cover Letter',
  'Notes',
  'Stages',
] as const;

/** Anshu's own outcome-tracking dropdown for the Stages column. */
export const STAGE_OPTIONS = ['Take home', 'Initial Screen', 'Final Round', 'Offer', 'NA', 'Invalid'] as const;

/** 0-indexed column offsets into a full A:P row, named for readability below. */
const COL = {
  jobId: 0,
  applied: 10,
  careerProfile: 11,
  technicalSkills: 12,
  coverLetter: 13,
  notes: 14,
  stages: 15,
} as const;

export interface SheetsConfig {
  spreadsheetId: string;
  sheetName: string;
  oauthClientPath: string;
  oauthTokenPath: string;
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
 * and that its header row has at least SHEET_HEADERS.length columns,
 * extending it in place (non-destructively) if it's short. Every function
 * below that touches the sheet calls this first: it's cheap (one metadata
 * read) and it means a tab renamed or trimmed by hand doesn't produce a
 * cryptic "Unable to parse range" from deep inside a values.get call —
 * it's caught here with the actual list of tabs that DO exist.
 */
async function ensureSheetAndHeader(client: sheets_v4.Sheets, cfg: SheetsConfig): Promise<void> {
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
  let headerRow = header.data.values?.[0] ?? [];

  // One-time migration: a sheet built before the Cover Letter column existed
  // has Notes/Stages sitting one column to the left of where SHEET_HEADERS
  // now expects them. Appending headers at the end (the normal path below)
  // would silently misread every row's Notes as Cover Letter and Stages as
  // Notes from here on — so when that's the situation, insert a real
  // spreadsheet column (which shifts every row's actual data with it, not
  // just the header label) before doing anything else.
  const coverLetterIdx = SHEET_HEADERS.indexOf('Cover Letter');
  if (headerRow[coverLetterIdx] !== 'Cover Letter' && headerRow.includes('Notes')) {
    const sheetId = (existingTab ?? meta.data.sheets?.find((s) => s.properties?.title === cfg.sheetName))
      ?.properties?.sheetId;
    if (sheetId == null) throw new Error(`Could not resolve sheetId for tab "${cfg.sheetName}" during migration.`);
    await client.spreadsheets.batchUpdate({
      spreadsheetId: cfg.spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: { sheetId, dimension: 'COLUMNS', startIndex: coverLetterIdx, endIndex: coverLetterIdx + 1 },
              inheritFromBefore: false,
            },
          },
        ],
      },
    });
    await client.spreadsheets.values.update({
      spreadsheetId: cfg.spreadsheetId,
      range: tabRange(cfg.sheetName, `${columnLetter(coverLetterIdx)}1`),
      valueInputOption: 'RAW',
      requestBody: { values: [['Cover Letter']] },
    });
    headerRow = [...headerRow.slice(0, coverLetterIdx), 'Cover Letter', ...headerRow.slice(coverLetterIdx)];
    await applyReadabilityFormatting(client, cfg, sheetId);
  }

  if (headerRow.length < SHEET_HEADERS.length) {
    await client.spreadsheets.values.update({
      spreadsheetId: cfg.spreadsheetId,
      range: tabRange(cfg.sheetName, `${columnLetter(headerRow.length)}1`),
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS.slice(headerRow.length)] },
    });
  }

  if (freshSheetId !== undefined) await applyReadabilityFormatting(client, cfg, freshSheetId);
}


/**
 * Freeze + bold the header row, checkbox-ify Applied, dropdown-ify Stages
 * (matching STAGE_OPTIONS), wrap the long free-text columns, and narrow the
 * columns nobody reads at a glance (Job ID, URL). Applied once, right after
 * the tab is created or migrated to the current column layout — re-running
 * it on every sync would be wasted API calls and would fight any manual
 * formatting tweak Anshu makes afterward.
 */
async function applyReadabilityFormatting(
  client: sheets_v4.Sheets,
  cfg: SheetsConfig,
  sheetId: number,
): Promise<void> {
  const lastRow = 5000; // generous fixed bound; cheap and avoids a row-count lookup
  const wrapColumns = [COL.careerProfile, COL.technicalSkills, COL.coverLetter, COL.notes];

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
        ...wrapColumns.map((col) => ({
          repeatCell: {
            range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: col, endColumnIndex: col + 1 },
            cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
            fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)',
          },
        })),
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: COL.jobId, endIndex: COL.jobId + 1 },
            properties: { pixelSize: 90 },
            fields: 'pixelSize',
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: 8, endIndex: 9 }, // URL
            properties: { pixelSize: 80 },
            fields: 'pixelSize',
          },
        },
        ...wrapColumns.map((col) => ({
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
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
 * Table's typed Applied (BOOLEAN) and Stages (DROPDOWN) columns plus all
 * formatting, none of which the plain data-validation API can (re)create
 * (see the comment in applyReadabilityFormatting). Then clears every data
 * row the duplicate copied over, leaving just the header and the Table
 * setup. Deterministic, no LLM — the caller (the `new-tracker-tab` CLI
 * command) is responsible for pointing config.json's sheetName at the
 * result so every subsequent sync-sheet targets the fresh tab.
 */
export async function startNewTrackerTab(auth: OAuth2Client, cfg: SheetsConfig): Promise<NewTabResult> {
  const client = sheetsClient(auth);
  await ensureSheetAndHeader(client, cfg);

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
    range: tabRange(newName, 'A2:P'),
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

/** 0-indexed column number -> A1 letter (0 -> 'A', 11 -> 'L', ...). Only needs single-letter range in this sheet's size. */
function columnLetter(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

function jobToRow(job: CleanJob, dateAdded: string): (string | number)[] {
  return [
    job.id,
    job.title,
    job.company,
    job.location,
    job.postedAt ?? '',
    job.salary ?? '',
    job.tags.join(', '),
    job.fitReason ?? '',
    job.url,
    dateAdded,
    '', // Applied — a checkbox Anshu ticks himself; sync-sheet reads it back, never writes it
    '', // Career Profile — filled in later by reconcileSheetColumns, never at append time
    '', // Technical Skills
    '', // Cover Letter — filled in later, once the career-profile agent has run
    '', // Notes
    '', // Stages — Anshu's own manual dropdown; sync-sheet reads it back, never writes it
  ];
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
  await ensureSheetAndHeader(client, cfg);
  const existingIds = await getExistingIds(client, cfg);

  const toAppend = jobs.filter((j) => !existingIds.has(j.id));
  const alreadyPresent = jobs.filter((j) => existingIds.has(j.id)).map((j) => j.id);

  if (toAppend.length > 0) {
    const now = new Date().toISOString().slice(0, 10);
    await client.spreadsheets.values.append({
      spreadsheetId: cfg.spreadsheetId,
      range: tabRange(cfg.sheetName, 'A:P'),
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: toAppend.map((j) => jobToRow(j, now)) },
    });
  }

  return { appended: toAppend.map((j) => j.id), alreadyPresent };
}

export interface SheetReconcileResult {
  /** Jobs where the Sheet already had a Career Profile Anshu typed in by
   *  hand — pulled back so jobs.json matches and export-profile-inbox never
   *  sends these to the LLM step again. */
  profilePulledBack: Array<{ id: string; careerProfile: string; technicalSkills: string[] }>;
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
}

/**
 * Two-way, no-LLM reconciliation of every editable column on the sheet:
 * Career Profile / Technical Skills / Cover Letter / Notes push or pull
 * depending on which side has content (a non-empty cell Anshu typed by
 * hand always wins and is pulled back; otherwise whatever jobs.json has
 * gets pushed). Applied and Stages are pull-only — Anshu is the only
 * writer of those two columns, this only ever reads them back into
 * jobs.json (via the caller's updateStatus/setInterviewStage) so that a
 * manual tick or dropdown pick takes every downstream agent off that job's
 * case on the very next run. Nothing here calls an LLM.
 */
export async function reconcileSheetColumns(
  auth: OAuth2Client,
  cfg: SheetsConfig,
  jobsById: Map<string, Job>,
): Promise<SheetReconcileResult> {
  const client = sheetsClient(auth);
  await ensureSheetAndHeader(client, cfg);
  const res = await client.spreadsheets.values.get({
    spreadsheetId: cfg.spreadsheetId,
    range: tabRange(cfg.sheetName, 'A:P'),
  });
  const rows = res.data.values ?? [];

  const profilePulledBack: SheetReconcileResult['profilePulledBack'] = [];
  const coverLetterPulledBack: SheetReconcileResult['coverLetterPulledBack'] = [];
  const markedApplied: string[] = [];
  const interviewStages: SheetReconcileResult['interviewStages'] = [];
  const pushed: string[] = [];
  const writes: sheets_v4.Schema$ValueRange[] = [];

  // rows[0] is the header; sheet rows are 1-indexed, so data row i (0-based
  // into `rows`, i >= 1) sits at sheet row i + 1.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const id = String(row[COL.jobId] ?? '');
    if (!id) continue;
    const job = jobsById.get(id);
    if (!job) continue; // row for a job no longer in jobs.json — leave it alone

    const sheetRowNum = i + 1;

    // --- Career Profile / Technical Skills ---
    const sheetProfile = String(row[COL.careerProfile] ?? '').trim();
    if (sheetProfile) {
      const sheetSkills = String(row[COL.technicalSkills] ?? '').trim();
      const skills = sheetSkills ? sheetSkills.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (job.careerProfile !== sheetProfile || (job.technicalSkills ?? []).join(',') !== skills.join(',')) {
        profilePulledBack.push({ id, careerProfile: sheetProfile, technicalSkills: skills });
      }
    } else if (job.careerProfile) {
      writes.push({
        range: tabRange(cfg.sheetName, `L${sheetRowNum}:M${sheetRowNum}`),
        values: [[job.careerProfile, (job.technicalSkills ?? []).join(', ')]],
      });
      pushed.push(id);
    }

    // --- Cover Letter ---
    const sheetCoverLetter = String(row[COL.coverLetter] ?? '').trim();
    if (sheetCoverLetter) {
      if (job.coverLetter !== sheetCoverLetter) {
        coverLetterPulledBack.push({ id, coverLetter: sheetCoverLetter });
      }
    } else if (job.coverLetter) {
      writes.push({
        range: tabRange(cfg.sheetName, `N${sheetRowNum}`),
        values: [[job.coverLetter]],
      });
      pushed.push(id);
    }

    // --- Notes: reflects whichever agent-side note (if any) is pending ---
    const desiredNote = job.profileNote ?? job.coverLetterNote ?? '';
    const currentNote = String(row[COL.notes] ?? '').trim();
    if (desiredNote !== currentNote) {
      writes.push({
        range: tabRange(cfg.sheetName, `O${sheetRowNum}`),
        values: [[desiredNote]],
      });
      pushed.push(id);
    }

    // --- Applied checkbox: pull-back only, Anshu is the only writer ---
    const appliedCell = row[COL.applied];
    const appliedChecked = appliedCell === true || /^(true|yes|1)$/i.test(String(appliedCell ?? ''));
    if (appliedChecked && job.pipelineStatus !== 'applied') {
      markedApplied.push(id);
    }

    // --- Stages: pull-back only, Anshu is the only writer ---
    const sheetStage = String(row[COL.stages] ?? '').trim();
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

  return { profilePulledBack, coverLetterPulledBack, markedApplied, interviewStages, pushed };
}
