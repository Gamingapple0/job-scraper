import type { Job } from './types.js';

const COLUMNS = [
  'title',
  'company',
  'city',
  'state',
  'remote',
  'employmentType',
  'salaryMin',
  'salaryMax',
  'salaryPeriod',
  'postedAt',
  'scrapedAt',
  'lastSeenAt',
  'closed',
  'pipelineStatus',
  'fitReason',
  'source',
  'seenOn',
  'tags',
  'url',
] as const;

export function toCsv(jobs: Job[]): string {
  const rows = [COLUMNS.join(',')];
  for (const j of jobs) {
    rows.push(
      [
        j.title,
        j.company,
        j.location.city ?? '',
        j.location.state ?? '',
        j.location.remote ? 'yes' : 'no',
        j.employmentType,
        j.salary?.min ?? '',
        j.salary?.max ?? '',
        j.salary?.period ?? '',
        j.postedAt ?? '',
        j.scrapedAt,
        j.lastSeenAt,
        j.closed ? 'yes' : 'no',
        j.pipelineStatus,
        j.fitReason ?? '',
        j.source,
        j.seenOn.join(' '),
        j.tags.join(' '),
        j.url,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return rows.join('\n');
}

/** "Melbourne, VIC" / "Remote" / whatever's on hand when city/state are missing. */
export function formatLocation(j: Job): string {
  const { city, state, remote, raw } = j.location;
  const parts = [city, state].filter(Boolean);
  const base = parts.length ? parts.join(', ') : raw;
  return remote && !/remote/i.test(base) ? `${base} (Remote)` : base;
}

/** "$110,000-$130,000/year", "$90+/hour", "up to $150,000/year", or "" if unknown. */
export function formatSalary(j: Job): string {
  if (!j.salary) return '';
  const { min, max, period } = j.salary;
  const fmt = (n?: number) => (n === undefined ? '' : `$${n.toLocaleString('en-AU')}`);
  if (min && max) return `${fmt(min)}-${fmt(max)}/${period}`;
  if (min) return `${fmt(min)}+/${period}`;
  if (max) return `up to ${fmt(max)}/${period}`;
  return '';
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** "7d", "24h", "2w" -> milliseconds. */
export function parseDuration(spec: string): number {
  const m = /^(\d+)\s*(h|d|w|m)$/i.exec(spec.trim());
  if (!m) throw new Error(`Bad duration "${spec}". Use forms like 24h, 7d, 2w, 1m.`);
  const n = Number(m[1]);
  switch ((m[2] ?? 'd').toLowerCase()) {
    case 'h':
      return n * 3_600_000;
    case 'w':
      return n * 7 * 86_400_000;
    case 'm':
      return n * 30 * 86_400_000;
    default:
      return n * 86_400_000;
  }
}
