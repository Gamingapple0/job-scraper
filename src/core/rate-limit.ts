/**
 * Per-host request pacing.
 *
 * Most scraper blocks are earned by request rate, not by fingerprinting.
 * Every outbound request goes through here: one at a time per host, with a
 * randomised gap so the traffic does not look metronomic.
 */
export class RateLimiter {
  private chains = new Map<string, Promise<void>>();
  private lastAt = new Map<string, number>();

  constructor(
    private readonly minDelayMs: number = 1500,
    private readonly jitterMs: number = 1500,
  ) {}

  /** Resolves when it is this caller's turn to hit `host`. */
  async acquire(host: string): Promise<void> {
    const prev = this.chains.get(host) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((res) => {
      release = res;
    });
    this.chains.set(
      host,
      prev.then(() => next),
    );

    await prev;

    const gap = this.minDelayMs + Math.random() * this.jitterMs;
    const last = this.lastAt.get(host) ?? 0;
    const waitFor = Math.max(0, last + gap - Date.now());
    if (waitFor > 0) await sleep(waitFor);
    this.lastAt.set(host, Date.now());

    // Release the slot on the next tick so the caller's request starts first.
    queueMicrotask(release);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
