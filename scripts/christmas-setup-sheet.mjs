// One-off: copies the main AU tracker tab (header, Table typed Applied/Stages
// columns, formatting) into the CC Tracker spreadsheet as "Tracker", clears its
// rows and deletes the default Sheet1. Run from the repo root after a build:
//   npm run build && node scripts/christmas-setup-sheet.mjs
// Safe to re-run: exits if the Tracker tab already exists.
import { loadConfig } from '../dist/core/config.js';
import { getAuthorizedClient } from '../dist/core/google-sheets.js';
import { sheets } from '@googleapis/sheets';
const main = await loadConfig('config/config.json');
const xmas = await loadConfig('config/christmas.json');
const auth = await getAuthorizedClient(main.pipeline.sheets);
const api = sheets({ version: 'v4', auth });
const src = await api.spreadsheets.get({ spreadsheetId: main.pipeline.sheets.spreadsheetId, fields: 'sheets(properties,tables(name,range))' });
const tab = src.data.sheets.find((s) => s.properties.title === main.pipeline.sheets.sheetName);
console.log('source tab', tab.properties.title, JSON.stringify(tab.tables?.map(t=>t.name)));
const dst = xmas.pipeline.sheets.spreadsheetId;
const existing = await api.spreadsheets.get({ spreadsheetId: dst, fields: 'sheets(properties(title))' });
if (existing.data.sheets.some((s) => s.properties.title === xmas.pipeline.sheets.sheetName)) {
  console.log(`CC Tracker already has a "${xmas.pipeline.sheets.sheetName}" tab, nothing to do.`);
  process.exit(0);
}
const copied = await api.spreadsheets.sheets.copyTo({ spreadsheetId: main.pipeline.sheets.spreadsheetId, sheetId: tab.properties.sheetId, requestBody: { destinationSpreadsheetId: dst } });
const newId = copied.data.sheetId;
const meta = await api.spreadsheets.get({ spreadsheetId: dst, fields: 'sheets(properties,tables(name,range))' });
const others = meta.data.sheets.filter((s) => s.properties.sheetId !== newId);
const requests = [
  ...others.map((s) => ({ deleteSheet: { sheetId: s.properties.sheetId } })),
  { updateSheetProperties: { properties: { sheetId: newId, title: xmas.pipeline.sheets.sheetName }, fields: 'title' } },
];
await api.spreadsheets.batchUpdate({ spreadsheetId: dst, requestBody: { requests } });
await api.spreadsheets.values.clear({ spreadsheetId: dst, range: `'${xmas.pipeline.sheets.sheetName}'!A2:Z` });
const after = await api.spreadsheets.get({ spreadsheetId: dst, fields: 'sheets(properties(title,gridProperties),tables(name,range,columnProperties))' });
console.log(JSON.stringify(after.data.sheets.map(s=>({t:s.properties.title,rows:s.properties.gridProperties.rowCount,tables:s.tables?.map(t=>({n:t.name,cols:t.columnProperties?.filter(c=>c.columnType&&c.columnType!=='TEXT').map(c=>c.columnName+':'+c.columnType)}))}))));
const hdr = await api.spreadsheets.values.get({ spreadsheetId: dst, range: `'${xmas.pipeline.sheets.sheetName}'!1:1` });
console.log(hdr.data.values[0].join(' | '));
