import { z } from 'zod';
import type { Store } from './store.js';
import { pickResumeVersion, RESUME_VERSIONS } from './resume-version.js';
import { lintCareerProfile, lintCoverLetter } from './tailoring-lint.js';

/**
 * Write-back for the combined career-profile + cover-letter step. One
 * verdict per job, same file for both pieces:
 *
 *   { id, resume_version, career_profile?, cover_letter? }
 *   { id, resume_version, error: "disqualifying_requirement" }
 *   { id, resume_version, error: "needs_clarification", questions: [...], error_stage? }
 *
 * `resume_version` is the base resume the agent says it tailored from. It is
 * checked against classifyResumeVersion(job): an agent that used the wrong
 * base is rejected instead of trusted, which is the guard that was missing
 * when a software-engineer profile went into a test-analyst application.
 * Every accepted profile/letter also passes the deterministic lint.
 */

export const MaterialsVerdictSchema = z
  .object({
    id: z.string(),
    resume_version: z.enum(RESUME_VERSIONS as [string, ...string[]]),
    career_profile: z.string().optional(),
    cover_letter: z.string().optional(),
    error: z.enum(['disqualifying_requirement', 'needs_clarification']).optional(),
    error_stage: z.enum(['career_profile', 'cover_letter']).optional(),
    questions: z.array(z.string()).min(1).optional(),
  })
  .refine((v) => Boolean(v.career_profile || v.cover_letter || v.error), { message: 'entry has nothing to apply' })
  .refine((v) => v.error !== 'needs_clarification' || Boolean(v.questions), {
    message: 'needs_clarification requires a non-empty questions array',
  });

export const MaterialsVerdictsSchema = z.array(MaterialsVerdictSchema);

export type MaterialsVerdict = z.infer<typeof MaterialsVerdictSchema>;

export interface MaterialsReport {
  profilesWritten: number;
  lettersWritten: number;
  flagged: number;
  skipped: Array<{ id: string; piece: string; reasons: string[] }>;
}

type ApplyStore = Pick<Store, 'get' | 'setProfile' | 'setCoverLetter'>;

export function applyMaterials(
  store: ApplyStore,
  verdicts: MaterialsVerdict[],
  opts: { dryRun?: boolean } = {},
): MaterialsReport {
  const report: MaterialsReport = { profilesWritten: 0, lettersWritten: 0, flagged: 0, skipped: [] };
  const skip = (id: string, piece: string, reasons: string[]) => report.skipped.push({ id, piece, reasons });

  for (const v of verdicts) {
    const job = store.get(v.id);
    if (!job) {
      skip(v.id, 'entry', ['unknown id']);
      continue;
    }

    const expected = pickResumeVersion(job);
    if (v.resume_version !== expected) {
      skip(v.id, 'entry', [
        `resume_version mismatch: written from "${v.resume_version}" but this job classifies as "${expected}" (${job.title}). Redo it from ${expected}.`,
      ]);
      continue;
    }

    if (v.error === 'disqualifying_requirement') {
      if (v.career_profile || v.cover_letter) {
        skip(v.id, 'entry', ['contradictory: disqualifying_requirement together with written text']);
        continue;
      }
      if (!opts.dryRun) {
        store.setProfile(v.id, { profileNote: 'DISQUALIFYING REQUIREMENT (visa/clearance/citizenship) — review manually.' });
      }
      report.flagged++;
      continue;
    }

    let profileReady = Boolean(job.careerProfile) && (job.careerProfileVersion ?? 'software-engineer') === expected;

    if (v.career_profile !== undefined) {
      const issues = lintCareerProfile(v.career_profile, job.company);
      if (issues.length > 0) {
        skip(v.id, 'career_profile', issues.map((i) => `career profile ${i}`));
        if (v.cover_letter !== undefined) skip(v.id, 'cover_letter', ['not applied: it depends on the career profile above']);
        continue;
      }
      if (!opts.dryRun) store.setProfile(v.id, { careerProfile: v.career_profile.trim(), version: expected });
      report.profilesWritten++;
      profileReady = true;
    }

    if (v.cover_letter !== undefined) {
      if (!profileReady) {
        skip(v.id, 'cover_letter', ['no current career profile for this job, so the letter is not applied']);
      } else {
        const issues = lintCoverLetter(v.cover_letter, job.company);
        if (issues.length > 0) skip(v.id, 'cover_letter', issues.map((i) => `cover letter ${i}`));
        else {
          if (!opts.dryRun) store.setCoverLetter(v.id, { coverLetter: v.cover_letter.trim(), version: expected });
          report.lettersWritten++;
        }
      }
    }

    if (v.error === 'needs_clarification' && v.questions) {
      const stage = v.error_stage ?? (v.career_profile !== undefined ? 'cover_letter' : 'career_profile');
      const note = `NEEDS CLARIFICATION: ${v.questions.join(' | ')}`;
      if (!opts.dryRun) {
        if (stage === 'career_profile') store.setProfile(v.id, { profileNote: note });
        else store.setCoverLetter(v.id, { coverLetterNote: note });
      }
      report.flagged++;
    }
  }
  return report;
}
