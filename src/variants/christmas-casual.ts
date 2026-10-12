import type { Config } from '../core/config.js';
import { PipelineProfile } from '../core/profile.js';
import type { ResumeVersion, ResumeVersionDecision } from '../core/resume-version.js';
import type { LintLimits } from '../core/tailoring-lint.js';

/**
 * Christmas casual (retail, hospitality, warehouse, seasonal) search.
 * Inherits the whole main pipeline; overrides only the job-type rules.
 * Runs against config/christmas.json: own dataDir, sheet and output folder,
 * so nothing here ever reads or writes the main tracker's jobs.json.
 * Disposable after the season: delete this file, the config and the prompts.
 */
export class ChristmasCasualProfile extends PipelineProfile {
  override readonly name = 'christmas-casual';
  override readonly hasIntlSheet = false;
  override readonly skillsHeading = 'Skills';
  override readonly titleHeadline = true;
  override readonly legacyVersion: ResumeVersion = 'christmas-casual';
  /** Seasonal recruiters skim: summary <= ~100 words, letter well under a page. */
  override readonly lintLimits: LintLimits = {
    profileWords: { min: 40, max: 110 },
    letterWords: { min: 140, max: 260 },
    letterParagraphs: { min: 3, max: 5 },
  };

  override classify(): ResumeVersionDecision {
    return { version: 'christmas-casual', reason: 'christmas casual pipeline has one base resume' };
  }

  override resumeFile(): string {
    return 'Claude outputs/christmas/resume-christmas-casual.md';
  }

  override resumeDocId(_v: ResumeVersion, cfg: Config): string {
    return cfg.pipeline.documentsResumeDocs.christmasCasual;
  }

  /** Availability is the first thing a seasonal recruiter screens on, so both pieces must state it. */
  override lintProfile(text: string, job: { company: string; title: string }): string[] {
    return [...super.lintProfile(text, job), ...availabilityIssue(text)];
  }

  override lintLetter(text: string, job: { company: string; title: string }): string[] {
    return [...super.lintLetter(text, job), ...availabilityIssue(text)];
  }
}

const AVAILABILITY = /\b(weekends?|evenings?|public holidays?|availab\w*|boxing day|christmas eve|new year)\b/i;

function availabilityIssue(text: string): string[] {
  return AVAILABILITY.test(text) ? [] : ['never states availability (weekends, evenings, public holidays)'];
}
