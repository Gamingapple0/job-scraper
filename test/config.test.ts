import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/core/config.js';

describe('loadConfig local override', () => {
  it('deep-merges config.local.json onto config.json without dropping sibling keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    const base = join(dir, 'config.json');
    const local = join(dir, 'config.local.json');
    await writeFile(
      base,
      JSON.stringify({
        pipeline: {
          fitInboxPath: './data/stage/fit-filter-inbox.json',
          sheets: { spreadsheetId: '', sheetName: 'Tracker' },
        },
      }),
    );
    await writeFile(local, JSON.stringify({ pipeline: { sheets: { spreadsheetId: 'real-id' } } }));

    const cfg = await loadConfig(base);
    expect(cfg.pipeline.sheets.spreadsheetId).toBe('real-id');
    expect(cfg.pipeline.sheets.sheetName).toBe('Tracker'); // sibling key survives the merge
    expect(cfg.pipeline.fitInboxPath).toBe('./data/stage/fit-filter-inbox.json'); // sibling object survives too
  });

  it('works fine with no local override file present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    const base = join(dir, 'config.json');
    await writeFile(base, JSON.stringify({}));
    const cfg = await loadConfig(base);
    expect(cfg.pipeline.sheets.spreadsheetId).toBe('');
  });
});
