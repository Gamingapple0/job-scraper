import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LoggerLike } from './types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  /** Also append JSON lines here. */
  file?: string;
}

export class Logger implements LoggerLike {
  private level: LogLevel;
  private file?: string;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? 'info';
    this.file = opts.file;
    if (this.file) mkdirSync(dirname(this.file), { recursive: true });
  }

  private write(level: LogLevel, msg: string, meta?: unknown): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const ts = new Date().toISOString();
    const tag = level.toUpperCase().padEnd(5);
    const line = `${ts} ${tag} ${msg}`;
    const suffix = meta === undefined ? '' : ` ${safeJson(meta)}`;
    if (level === 'error' || level === 'warn') console.error(line + suffix);
    else console.log(line + suffix);
    if (this.file) {
      try {
        appendFileSync(this.file, JSON.stringify({ ts, level, msg, meta }) + '\n');
      } catch {
        /* logging must never break a run */
      }
    }
  }

  debug(msg: string, meta?: unknown): void {
    this.write('debug', msg, meta);
  }
  info(msg: string, meta?: unknown): void {
    this.write('info', msg, meta);
  }
  warn(msg: string, meta?: unknown): void {
    this.write('warn', msg, meta);
  }
  error(msg: string, meta?: unknown): void {
    this.write('error', msg, meta);
  }
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 400 ? s.slice(0, 400) + '...' : s;
  } catch {
    return String(v);
  }
}
