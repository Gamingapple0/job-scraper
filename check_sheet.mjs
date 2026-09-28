import { readFile } from 'node:fs/promises';
import { google } from 'googleapis';

async function getClient(oauthClientPath, oauthTokenPath) {
  const clientJson = JSON.parse(await readFile(oauthClientPath, 'utf8'));
  const c = clientJson.installed || clientJson.web;
  const oAuth2Client = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris[0]);
  const token = JSON.parse(await readFile(oauthTokenPath, 'utf8'));
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

async function inspect(label, spreadsheetId, oauthClientPath, oauthTokenPath) {
  const auth = await getClient(oauthClientPath, oauthTokenPath);
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  console.log(`=== ${label} (${spreadsheetId}) ===`);
  console.log('Title:', meta.data.properties.title);
  console.log('Tabs:', meta.data.sheets.map(s => `${s.properties.title} (gid=${s.properties.sheetId})`).join(', '));
  for (const s of meta.data.sheets) {
    const tabName = s.properties.title;
    try {
      const vals = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A:C` });
      const rows = vals.data.values || [];
      console.log(`  Tab "${tabName}": ${rows.length} rows (incl header). Last 5:`, JSON.stringify(rows.slice(-5)));
    } catch (e) {
      console.log(`  Tab "${tabName}": error reading -`, e.message);
    }
  }
}

await inspect('AU spreadsheet', '1ZuDgq_DeCXviZGfCIVVMj0yH6jMFzupOo6Gnx_vM3qw', './config/google-oauth-client.json', './config/google-oauth-token.json');
console.log();
await inspect('INTL spreadsheet', '1GTabvF447K48j-WoeAmXrqZV1xSLPW4TuvoBAWvubrg', './config/google-oauth-client.json', './config/google-oauth-token.json');
