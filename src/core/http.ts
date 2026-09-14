import type { HttpLike, LoggerLike, RequestInitLike } from './types.js';
import { RateLimiter, sleep } from './rate-limit.js';
import type { ResponseCache } from './cache.js';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Thrown when a source keeps refusing. The pipeline stops that source for the run. */
export class BlockedError extends HttpError {
  override name = 'BlockedError';
}

export interface HttpClientOptions {
  limiter: RateLimiter;
  cache: ResponseCache;
  logger: LoggerLike;
  userAgent: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** Backoff schedule in ms for retryable failures. */
  backoffMs?: number[];
}

export class HttpClient implements HttpLike {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoff: number[];

  constructor(private readonly opts: HttpClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 3;
    this.backoff = opts.backoffMs ?? [5_000, 15_000, 45_000];
  }

  async getText(url: string, init: RequestInitLike = {}): Promise<string> {
    const cached = init.noCache ? undefined : await this.opts.cache.get(url, init.cacheTtlMs);
    if (cached !== undefined) {
      this.opts.logger.debug('cache hit', { url });
      return cached;
    }

    const host = new URL(url).host;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.opts.limiter.acquire(host);

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': this.opts.userAgent,
            'Accept-Language': 'en-AU,en;q=0.9',
            ...(this.opts.defaultHeaders ?? {}),
            ...(init.headers ?? {}),
          },
          redirect: 'follow',
          signal: ctrl.signal,
        });

        if (res.ok) {
          const body = await res.text();
          if (!init.noCache) await this.opts.cache.set(url, body);
          this.opts.logger.debug('fetched', { url, status: res.status, bytes: body.length });
          return body;
        }

        const body = await res.text().catch(() => '');
        if (isRetryable(res.status) && attempt < this.retries) {
          const wait = this.backoff[Math.min(attempt, this.backoff.length - 1)] ?? 30_000;
          this.opts.logger.warn('retryable response, backing off', {
            url,
            status: res.status,
            attempt: attempt + 1,
            waitMs: wait,
          });
          await sleep(wait);
          continue;
        }
        if (res.status === 403 || res.status === 429) {
          throw new BlockedError(`Blocked by ${host} (HTTP ${res.status})`, res.status, url, body.slice(0, 500));
        }
        throw new HttpError(`HTTP ${res.status} for ${url}`, res.status, url, body.slice(0, 500));
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpError) throw err;
        if (attempt < this.retries) {
          const wait = this.backoff[Math.min(attempt, this.backoff.length - 1)] ?? 30_000;
          this.opts.logger.warn('request failed, retrying', {
            url,
            attempt: attempt + 1,
            waitMs: wait,
            error: String(err),
          });
          await sleep(wait);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw new HttpError(`Request failed after ${this.retries + 1} attempts: ${String(lastErr)}`, 0, url);
  }

  async getJson<T = unknown>(url: string, init: RequestInitLike = {}): Promise<T> {
    const text = await this.getText(url, {
      ...init,
      headers: { Accept: 'application/json, text/plain, */*', ...(init.headers ?? {}) },
    });
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(
        `Response was not JSON (first 200 chars: ${text.slice(0, 200)})`,
        200,
        url,
      );
    }
  }
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
