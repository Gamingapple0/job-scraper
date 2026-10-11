#!/usr/bin/env node
// Turns good fit verdicts into application folders ready for make_pack.
// Usage: node scripts/apply_cards.mjs data/stage/fit-verdicts.json
// For each good verdict carrying a card (thesis, archetype, lead, musthaves): app-new if no folder
// has that jobId yet, then write thesis/archetype/lead/mustHaves into its application.json.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const rd = (p) => fs.readFileSync(p, 'utf8');
const folderFor = (id) =>
  fs.readdirSync('applications').find((f) => {
    try {
      return JSON.parse(rd(`applications/${f}/application.json`)).jobId === id;
    } catch {
      return false;
    }
  });

const cards = JSON.parse(rd(process.argv[2])).filter((v) => v.verdict === 'good' && v.thesis);
const done = [];
const failed = [];
for (const c of cards) {
  let f = folderFor(c.id);
  if (!f) {
    const r = spawnSync('node', ['dist/cli.js', 'app-new', c.id], { encoding: 'utf8' });
    f = folderFor(c.id);
    if (!f) {
      failed.push(`${c.id}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
      continue;
    }
  }
  const p = `applications/${f}/application.json`;
  const a = JSON.parse(rd(p));
  if (a.status !== 'draft' || fs.existsSync(`applications/${f}/letter.txt`)) continue; // already written
  Object.assign(a, { thesis: c.thesis, archetype: c.archetype ?? a.archetype, lead: c.lead, mustHaves: c.musthaves ?? [] });
  fs.writeFileSync(p, JSON.stringify(a, null, 2) + '\n', 'utf8');
  done.push(f);
}
console.log(`CARDS_RESULT ${JSON.stringify({ written: done.length, folders: done, failed })}`);
