import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Job, PipelineStatus, RunStats, UpsertResult } from './types.js';
import { isProbablySameJob, mergeJob } from './dedupe.js';
import { advanceStatus, type TransitionResult } from './pipeline-status.js';

/**
 * Storage contract. JsonStore is the implementation; swapping to SQLite later
 * means writing one more class here and changing one line in cli.ts.
 */
export interface Store {
  load(): Promise<void>;
  all(): Job[];
  get(id: string): Job | undefined;
  upsert(job: Job): UpsertResult;
  /** Marks jobs not seen in this run. Returns how many crossed the closed threshold. */
  ageOut(seenIds: Set<string>, closeAfterMissedRuns: number): number;
  /**
   * Advance one job's pipelineStatus, or refuse if the move isn't allowed
   * (unknown id, or a transition not in the allow-list). Every caller that
   * writes a pipeline status — apply-fit-verdicts, mark-applied, sync-applied
   * — goes through this single choke point.
   */
  updateStatus(
    id: string,
    to: PipelineStatus,
    opts: { actor: string; reason?: string },
  ): TransitionResult | { ok: false; reason: 'unknown id' };
  /**
   * Patch the career-profile side-fields directly — no ratchet, no allowed-
   * transition graph, since these are orthogonal to pipelineStatus (see the
   * Job.profileNote doc comment). Passing `careerProfile` clears any
   * existing `profileNote` automatically, since a job either has a profile
   * or is still waiting on one, never both.
   */
  setProfile(
    id: string,
    patch: { careerProfile: string; technicalSkills: string[] } | { profileNote: string },
  ): { ok: true } | { ok: false; reason: 'unknown id' };
  /** Same shape and rules as setProfile, for the cover-letter side-fields. */
  setCoverLetter(
    id: string,
    patch: { coverLetter: string } | { coverLetterNote: string },
  ): { ok: true } | { ok: false; reason: 'unknown id' };
  /** Sets Anshu's manual interviewStage tracking field. No ratchet, no allowed-transition graph. */
  setInterviewStage(id: string, stage: string): { ok: true } | { ok: false; reason: 'unknown id' };
  save(): Promise<void>;
  writeRunSnapshot(stats: RunStats[], changed: { created: string[]; updated: string[] }): Promise<string>;
  history(): Promise<RunHistoryEntry[]>;
}

export interface RunHistoryEntry {
  finishedAt: string;
  source: string;
  query: string;
  fetched: number;
  created: number;
}

interface StoreFile {
  version: 1;
  updatedAt: string;
  jobs: Record<string, Job>;
}

export class JsonStore implements Store {
  private jobs = new Map<string, Job>();
  private byFingerprint = new Map<string, string>();
  private loaded = false;

  constructor(
    private readonly dataDir: string,
    private readonly fuzzyDedupe = true,
  ) {}

  private get jobsPath(): string {
    return join(this.dataDir, 'jobs.json');
  }
  private get runsDir(): string {
    return join(this.dataDir, 'runs');
  }
  private get historyPath(): string {
    return join(this.dataDir, 'runs', 'index.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const text = await readFile(this.jobsPath, 'utf8');
      const parsed = JSON.parse(text) as StoreFile;
      for (const job of Object.values(parsed.jobs ?? {})) {
        this.jobs.set(job.id, job);
        this.byFingerprint.set(job.fingerprint, job.id);
      }
    } catch {
      // First run: no file yet.
    }
    this.loaded = true;
  }

  all(): Job[] {
    return [...this.jobs.values()];
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  upsert(incoming: Job): UpsertResult {
    const exact = this.jobs.get(incoming.id);
    if (exact) {
      const merged = mergeJob(exact, incoming);
      this.jobs.set(merged.id, merged);
      return { status: 'updated', job: merged };
    }

    const fpId = this.byFingerprint.get(incoming.fingerprint);
    const fpMatch = fpId ? this.jobs.get(fpId) : undefined;
    if (fpMatch) {
      const merged = mergeJob(fpMatch, incoming);
      this.jobs.set(merged.id, merged);
      // Point the new source id at the canonical record too, so the next run
      // of that source finds it by exact id.
      this.jobs.set(incoming.id, merged);
      return { status: 'merged', job: merged };
    }

    if (this.fuzzyDedupe) {
      for (const candidate of this.jobs.values()) {
        if (candidate.source === incoming.source) continue;
        if (isProbablySameJob(candidate, incoming)) {
          const merged = mergeJob(candidate, incoming);
          this.jobs.set(merged.id, merged);
          this.jobs.set(incoming.id, merged);
          return { status: 'merged', job: merged };
        }
      }
    }

    this.jobs.set(incoming.id, incoming);
    this.byFingerprint.set(incoming.fingerprint, incoming.id);
    return { status: 'new', job: incoming };
  }

  updateStatus(
    id: string,
    to: PipelineStatus,
    opts: { actor: string; reason?: string },
  ): TransitionResult | { ok: false; reason: 'unknown id' } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, reason: 'unknown id' };
    const result = advanceStatus(job, to, opts);
    if (result.ok) this.jobs.set(id, result.job);
    return result;
  }

  setProfile(
    id: string,
    patch: { careerProfile: string; technicalSkills: string[] } | { profileNote: string },
  ): { ok: true } | { ok: false; reason: 'unknown id' } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, reason: 'unknown id' };
    if ('careerProfile' in patch) {
      job.careerProfile = patch.careerProfile;
      job.technicalSkills = patch.technicalSkills;
      job.profileNote = undefined;
    } else {
      job.profileNote = patch.profileNote;
    }
    return { ok: true };
  }

  setCoverLetter(
    id: string,
    patch: { coverLetter: string } | { coverLetterNote: string },
  ): { ok: true } | { ok: false; reason: 'unknown id' } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, reason: 'unknown id' };
    if ('coverLetter' in patch) {
      job.coverLetter = patch.coverLetter;
      job.coverLetterNote = undefined;
    } else {
      job.coverLetterNote = patch.coverLetterNote;
    }
    return { ok: true };
  }

  setInterviewStage(id: string, stage: string): { ok: true } | { ok: false; reason: 'unknown id' } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, reason: 'unknown id' };
    job.interviewStage = stage;
    return { ok: true };
  }

  ageOut(seenIds: Set<string>, closeAfterMissedRuns: number): number {
    let closed = 0;
    for (const job of this.jobs.values()) {
      if (seenIds.has(job.id)) continue;
      job.missedRuns += 1;
      if (!job.closed && job.missedRuns >= closeAfterMissedRuns) {
        job.closed = true;
        closed++;
      }
    }
    return closed;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.jobsPath), { recursive: true });
    const payload: StoreFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      jobs: Object.fromEntries(this.jobs),
    };
    const tmp = `${this.jobsPath}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tmp, this.jobsPath); // atomic: a crash never truncates jobs.json
  }

  async writeRunSnapshot(
    stats: RunStats[],
    changed: { created: string[]; updated: string[] },
  ): Promise<string> {
    await mkdir(this.runsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(this.runsDir, `${stamp}.json`);
    await writeFile(file, JSON.stringify({ finishedAt: new Date().toISOString(), stats, changed }, null, 2), 'utf8');

    const hist = await this.history();
    for (const s of stats) {
      hist.push({
        finishedAt: s.finishedAt,
        source: s.source,
        query: s.query,
        fetched: s.fetched,
        created: s.created,
      });
    }
    await writeFile(this.historyPath, JSON.stringify(hist.slice(-500), null, 2), 'utf8');
    return file;
  }

  async history(): Promise<RunHistoryEntry[]> {
    try {
      return JSON.parse(await readFile(this.historyPath, 'utf8')) as RunHistoryEntry[];
    } catch {
      return [];
    }
  }
}
