import type { Job, PipelineStatus } from './types.js';

/**
 * The complete set of allowed status transitions. Anything not listed here
 * is refused, not just discouraged — this is what makes it safe to run the
 * whole thing unattended: a bug in a downstream agent can't silently rewind
 * a job's status and cause it to be re-processed (and re-billed) later.
 */
const ALLOWED_TRANSITIONS: Record<PipelineStatus, readonly PipelineStatus[]> = {
  scraped: ['fit_good', 'fit_bad'],
  fit_good: ['tracked', 'applied'],
  fit_bad: [], // terminal: a rejected job is never re-judged by a later scrape
  tracked: ['applied'],
  applied: [], // terminal
};

export function canTransition(from: PipelineStatus, to: PipelineStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export type TransitionResult =
  | { ok: true; job: Job }
  | { ok: false; reason: string; from: PipelineStatus };

/**
 * Pure function: given a job and a target status, either returns a new Job
 * with the status advanced and the event appended to statusHistory, or an
 * explanation of why the move was refused. Never mutates its input, so a
 * caller can always compare before/after or discard a rejected attempt.
 */
export function advanceStatus(
  job: Job,
  to: PipelineStatus,
  opts: { actor: string; reason?: string; at?: string },
): TransitionResult {
  const from = job.pipelineStatus;

  if (from === to) {
    return { ok: false, reason: `already ${to}`, from };
  }
  if (!canTransition(from, to)) {
    return { ok: false, reason: `cannot move from ${from} to ${to}`, from };
  }

  const event = {
    at: opts.at ?? new Date().toISOString(),
    from,
    to,
    actor: opts.actor,
    ...(opts.reason ? { reason: opts.reason } : {}),
  };

  const updated: Job = {
    ...job,
    pipelineStatus: to,
    statusHistory: [...job.statusHistory, event],
    ...(opts.reason && (to === 'fit_good' || to === 'fit_bad') ? { fitReason: opts.reason } : {}),
  };

  return { ok: true, job: updated };
}
