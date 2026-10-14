import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * The fact ledger (profile/facts.yaml): the only source of claims a v2
 * resume, letter or outreach note may make. Loaded and shape-checked here;
 * the checks that hold documents to it live in application.ts.
 */

const Bounds = z.object({ min: z.number().int(), max: z.number().int() });

const Entry = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string(),
  start: z.string(),
  end: z.string(),
  bullets: Bounds,
  facts: z.array(z.string()).min(1),
});

const Project = z.object({
  id: z.string(),
  name: z.string(),
  stack: z.array(z.string()),
  bullets: Bounds,
  facts: z.array(z.string()).min(1),
});

export const LedgerSchema = z.object({
  contact: z.object({
    name: z.string(),
    location: z.string(),
    phone: z.string(),
    phone_intl: z.string(),
    email: z.string(),
    linkedin: z.string(),
    website: z.string(),
  }),
  roles: z.array(Entry).min(1),
  projects: z.array(Project),
  education: z.array(
    z.object({ id: z.string(), degree: z.string(), school: z.string(), start: z.string().optional(), end: z.string(), degree_note: z.string().optional(), display: z.string(), facts: z.array(z.string()) }),
  ),
  transcript: z.array(z.object({ code: z.string(), name: z.string(), mark: z.number() })),
  other: z.object({ facts: z.array(z.string()) }),
  letter_only: z.array(z.object({ id: z.string(), facts: z.array(z.string()), tools: z.array(z.string()), requires_jd: z.array(z.string()) })),
  screening: z.record(z.string()),
  skills: z.object({
    core: z.array(z.string()),
    jd: z.array(z.string()),
    exposure: z.array(z.string()),
    evidenced_jd: z.array(z.string()),
    evidenced_exposure: z.array(z.string()),
  }),
  aliases: z.record(z.array(z.string())),
  side: z.object({ facts: z.array(z.string()) }).default({ facts: [] }),
  jd_synonyms: z.record(z.array(z.string())).default({}),
});

export type Ledger = z.infer<typeof LedgerSchema>;
export type LedgerRole = z.infer<typeof Entry>;
export type LedgerProject = z.infer<typeof Project>;

export const LEDGER_PATH = 'profile/facts.yaml';

export function loadLedger(path = LEDGER_PATH): Ledger {
  return LedgerSchema.parse(parse(readFileSync(path, 'utf8')));
}

/** How a skill may be placed on the Skills section. */
export type Placement = 'core' | 'jd' | 'exposure';

/** canonical lower-case name or alias -> { name, placement } */
export function skillIndex(l: Ledger): Map<string, { name: string; placement: Placement }> {
  const out = new Map<string, { name: string; placement: Placement }>();
  const add = (names: string[], placement: Placement) => {
    for (const name of names) {
      for (const n of [name, ...(l.aliases[name] ?? [])]) out.set(n.toLowerCase(), { name, placement });
    }
  };
  add(l.skills.core, 'core');
  add([...l.skills.jd, ...l.skills.evidenced_jd], 'jd');
  add([...l.skills.exposure, ...l.skills.evidenced_exposure], 'exposure');
  return out;
}

/** Every fact line a resume may draw on (letter-only facts excluded). */
export function resumeFacts(l: Ledger): string[] {
  return [
    ...l.roles.flatMap((r) => [`${r.title} ${r.company} ${r.start} ${r.end}`, ...r.facts]),
    ...l.projects.flatMap((p) => [`${p.name} ${p.stack.join(' ')}`, ...p.facts]),
    ...l.education.flatMap((e) => [`${e.degree} ${e.school} ${e.start ?? ''} ${e.end}`, ...e.facts]),
    ...l.transcript.map((t) => `${t.code} ${t.name} mark ${t.mark}`),
    ...l.other.facts,
    ...l.side.facts,
  ];
}

export function letterFacts(l: Ledger, jd: string): string[] {
  const extra = l.letter_only.filter((x) => x.requires_jd.some((k) => new RegExp(`\\b${k}\\b`, 'i').test(jd))).flatMap((x) => x.facts);
  return [...resumeFacts(l), ...extra];
}
