import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * On-disk response cache.
 *
 * The single highest-value piece of this project: when a parser breaks because
 * a site changed its JSON shape, you re-run parsing against cached bytes
 * instead of re-hitting the site and re-earning a rate limit.
 */
export class ResponseCache {
  constructor(
    private readonly dir: string,
    private readonly defaultTtlMs: number,
    private readonly enabled = true,
  ) {}

  private keyFor(url: string): string {
    return createHash('sha1').update(url).digest('hex');
  }

  private pathFor(url: string): string {
    return join(this.dir, `${this.keyFor(url)}.txt`);
  }

  async get(url: string, ttlMs?: number): Promise<string | undefined> {
    if (!this.enabled) return undefined;
    const p = this.pathFor(url);
    try {
      const s = await stat(p);
      const ttl = ttlMs ?? this.defaultTtlMs;
      if (ttl >= 0 && Date.now() - s.mtimeMs > ttl) return undefined;
      return await readFile(p, 'utf8');
    } catch {
      return undefined;
    }
  }

  async set(url: string, body: string): Promise<void> {
    if (!this.enabled) return;
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(url), body, 'utf8');
  }

  /** Writes a named sample file for humans to read. Used by `cli discover`. */
  async writeSample(name: string, body: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const p = join(this.dir, name);
    await writeFile(p, body, 'utf8');
    return p;
  }
}
