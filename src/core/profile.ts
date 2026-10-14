import type { Config } from './config.js';
import {
  classifyResumeVersion,
  LEGACY_RESUME_VERSION,
  RESUME_BASE_FILE,
  RESUME_DOC_KEY,
  type ResumeVersion,
  type ResumeVersionDecision,
  type ResumeVersionInput,
  type TechResumeVersion,
} from './resume-version.js';
import { DEFAULT_LIMITS, lintCareerProfile, lintCoverLetter, type LintLimits } from './tailoring-lint.js';

/**
 * The job-type rules of a pipeline: which base resume a job gets, where that
 * resume lives, and what the tailored text must pass. This base class IS the
 * main (software/test) tracker. A seasonal search subclasses it and
 * overrides only what differs (see src/variants/), and points a config file
 * with its own dataDir, sheet and output folder at that subclass through
 * `"profile"`. Everything else (scraping, dedupe, status ratchet, sheet sync,
 * documents) is shared code that asks activeProfile() instead of hardcoding
 * the tech rules.
 */
export class PipelineProfile {
  readonly name: string = 'main';
  /** Also sync pipeline.sheetsIntl. The main tracker splits AU vs international. */
  readonly hasIntlSheet: boolean = true;
  /** Heading of the comma-separated skills paragraph in the base resume Google Doc. */
  readonly skillsHeading: string = 'Technical Skills';
  /** Version assumed for text written before stamping existed. */
  readonly legacyVersion: ResumeVersion = LEGACY_RESUME_VERSION;
  readonly lintLimits: LintLimits = DEFAULT_LIMITS;
  /**
   * Put the posting's exact title next to the name and require it in the
   * profile. Off for the main tracker since framework v2 (no title next to
   * the name); the seasonal profile keeps it.
   */
  readonly titleHeadline: boolean = false;

  classify(job: ResumeVersionInput): ResumeVersionDecision {
    return classifyResumeVersion(job);
  }

  /** Markdown copy of the base resume the LLM stages read. */
  resumeFile(version: ResumeVersion): string {
    return RESUME_BASE_FILE[version as TechResumeVersion];
  }

  /** Google Doc id of the base resume generate-documents fills in. */
  resumeDocId(version: ResumeVersion, cfg: Config): string {
    return cfg.pipeline.documentsResumeDocs[RESUME_DOC_KEY[version as TechResumeVersion]];
  }

  lintProfile(text: string, job: { company: string; title: string }): string[] {
    return lintCareerProfile(text, job.company, this.titleHeadline ? job.title : undefined, this.lintLimits);
  }

  lintLetter(text: string, job: { company: string; title: string }): string[] {
    return lintCoverLetter(text, job.company, this.lintLimits);
  }
}

let active: PipelineProfile = new PipelineProfile();

export function activeProfile(): PipelineProfile {
  return active;
}

export function setActiveProfile(p: PipelineProfile): void {
  active = p;
}

/** The resume version a job needs under the active profile. The one call every stage makes. */
export function pickResumeVersion(job: ResumeVersionInput): ResumeVersion {
  return active.classify(job).version;
}
