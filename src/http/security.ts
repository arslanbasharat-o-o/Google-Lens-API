import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { AuthenticationError, ConflictError, RateLimitError } from '../domain/errors.js';

interface RateWindow {
  startedAt: number;
  count: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, RateWindow>();

  public constructor(
    private readonly limit: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  public consume(key: string): void {
    const now = this.now();
    const existing = this.windows.get(key);
    if (!existing || now - existing.startedAt >= 60_000) {
      this.windows.set(key, { startedAt: now, count: 1 });
      this.prune(now);
      return;
    }
    if (existing.count >= this.limit) throw new RateLimitError(this.limit);
    existing.count += 1;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= 60_000) this.windows.delete(key);
    }
    if (this.windows.size <= this.maxEntries) return;
    const oldest = [...this.windows.entries()].sort((left, right) => left[1].startedAt - right[1].startedAt);
    for (const [key] of oldest) {
      if (this.windows.size <= this.maxEntries) break;
      this.windows.delete(key);
    }
  }
}

export class ApiKeyAuthenticator {
  public constructor(
    private readonly keys: string[],
    private readonly required: boolean,
    private readonly allowQueryApiKey = false,
  ) {}

  public getPrincipal(request: FastifyRequest): string | undefined {
    const supplied = readApiKey(request, this.allowQueryApiKey);
    if (this.keys.length === 0) {
      if (this.required) throw new AuthenticationError();
      return supplied ? fingerprint(supplied) : undefined;
    }
    if (!supplied || !this.keys.some((key) => safeEqual(key, supplied))) {
      throw new AuthenticationError();
    }
    return fingerprint(supplied);
  }
}

export function readApiKey(request: FastifyRequest, allowQueryApiKey = false): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length).trim() || undefined;
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (!allowQueryApiKey) return undefined;
  const query = request.query as Record<string, unknown>;
  const queryKey = query?.api_key;
  return typeof queryKey === 'string' && queryKey.trim() ? queryKey.trim() : undefined;
}

export function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim().slice(0, 200);
}

export class IdempotencyStore<T> {
  private readonly values = new Map<string, { fingerprint: string; value: T; expiresAt: number }>();

  public constructor(
    private readonly retentionMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  public get(key: string, fingerprintValue: string): T | undefined {
    this.prune();
    const existing = this.values.get(key);
    if (!existing) return undefined;
    if (existing.fingerprint !== fingerprintValue) {
      throw new ConflictError('The Idempotency-Key was already used with a different request payload.');
    }
    return existing.value;
  }

  public set(key: string, fingerprintValue: string, value: T): void {
    this.prune();
    this.values.set(key, {
      fingerprint: fingerprintValue,
      value,
      expiresAt: this.now() + this.retentionMs,
    });
  }

  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.values) {
      if (value.expiresAt <= now) this.values.delete(key);
    }
  }
}

function safeEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fingerprint(value: string): string {
  return `api-key:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}
