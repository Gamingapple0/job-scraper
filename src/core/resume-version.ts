/**
 * The ONE place that decides which base resume a job is tailored from.
 *
 * Before this existed there were two independent decisions that could
 * disagree: `pickResumeVersion` (a stub that always said software-engineer,
 * so the career-profile and cover-letter agents only ever saw the software
 * engineer resume) and `pickResumeDoc` (a title-only regex used by the
 * documents stage, which missed titles like "API Automation Tester" and
 * caught false positives like "AI Automation Engineer"). Every stage now
 * calls `classifyResumeVersion` and nothing else, and the result is stamped
 * on the generated text (see Job.careerProfileVersion / coverLetterVersion)
 * so a mismatch can be detected later instead of silently shipping.
 *
 * Plain deterministic code, zero LLM tokens.
 */

export type ResumeVersion = 'software-engineer' | 'test-analyst';

export const RESUME_VERSIONS: readonly ResumeVersion[] = ['software-engineer', 'test-analyst'];

/** Where the LLM stages read each base resume from (paths relative to the repo root). */
export const RESUME_BASE_FILE: Record<ResumeVersion, string> = {
  'software-engineer': 'Claude outputs/resume.md',
  'test-analyst': 'Claude outputs/resume-test-analyst.md',
};

/** Key into config.pipeline.documentsResumeDocs for each version's Google Doc. */
export const RESUME_DOC_KEY: Record<ResumeVersion, 'softwareEngineer' | 'testAnalyst'> = {
  'software-engineer': 'softwareEngineer',
  'test-analyst': 'testAnalyst',
};

/**
 * What a job that predates version stamping was written from: only the
 * software-engineer base existed then, so an unstamped profile/letter is a
 * software-engineer one by construction.
 */
export const LEGACY_RESUME_VERSION: ResumeVersion = 'software-engineer';

/** Titles that are unambiguously testing/QA roles. */
const TEST_TITLE =
  /\b(qa|q\.a\.|qe|sdet|tester|testers|testing|test analyst|test engineer|test automation|automation test(?:er|ers|ing)?|quality assurance|quality engineer(?:ing)?|software engineer in test|test lead|test consultant|test specialist)\b/i;

/** Title mentions automation but is not clearly testing ("AI Automation Engineer", "Automation Engineer"): decided by the JD. */
const AMBIGUOUS_TITLE = /\bautomation\b/i;

const TEST_TERMS =
  /\b(test automation|automated tests?|automated testing|test (?:cases?|scripts?|plans?|strategy|frameworks?|suites?)|regression tests?|regression testing|manual testing|exploratory testing|qa|quality assurance|uat|selenium|playwright|cypress|webdriver(?:io)?|appium|cucumber|testrail|jmeter|postman|soapui|rest-assured|defect triage|bug triage)\b/gi;

const NON_TEST_AUTOMATION_TERMS =
  /\b(rpa|uipath|blue prism|power automate|process automation|workflow automation|business process|servicenow|zapier|n8n|terraform|ansible|infrastructure as code|devops|robotics|plc|scada|industrial|marketing automation|salesforce|crm|ai agents?|llm)\b/gi;

/** How much of the JD is read for the ambiguous-title tiebreak: the requirements sit near the top, boilerplate at the bottom. */
const DESCRIPTION_WINDOW = 6000;

/** Fewer testing terms than this is incidental mention, not a testing role (a data-automation analyst JD scored 3; a real automation-tester JD scored 11). */
const MIN_TEST_TERMS = 4;

export interface ResumeVersionInput {
  title: string;
  description?: string;
}

export interface ResumeVersionDecision {
  version: ResumeVersion;
  /** Short human-readable why, for audit output and logs. */
  reason: string;
}

function count(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

export function classifyResumeVersion(job: ResumeVersionInput): ResumeVersionDecision {
  if (TEST_TITLE.test(job.title)) {
    return { version: 'test-analyst', reason: 'title names a testing/QA role' };
  }
  if (AMBIGUOUS_TITLE.test(job.title)) {
    const jd = (job.description ?? '').slice(0, DESCRIPTION_WINDOW);
    const testHits = count(TEST_TERMS, jd);
    const otherHits = count(NON_TEST_AUTOMATION_TERMS, jd);
    if (testHits >= MIN_TEST_TERMS && testHits > otherHits * 1.5) {
      return {
        version: 'test-analyst',
        reason: `"automation" title, JD is testing-heavy (${testHits} testing terms vs ${otherHits} non-testing automation terms)`,
      };
    }
    return {
      version: 'software-engineer',
      reason: `"automation" title, but JD is not testing-heavy (${testHits} testing terms vs ${otherHits} non-testing automation terms)`,
    };
  }
  return { version: 'software-engineer', reason: 'no testing/QA signal in the title' };
}

export function pickResumeVersion(job: ResumeVersionInput): ResumeVersion {
  return classifyResumeVersion(job).version;
}
