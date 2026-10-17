import { Redis } from 'ioredis';

import { LensAutomationError } from '../domain/errors.js';
import type { SearchOptions, SerpApiResponse, VisualMatch } from '../domain/types.js';
import {
  closeRedis,
  connectRedis,
  requireRedisCommand,
  type RedisClientLike,
} from '../storage/redis-client.js';
import { LENS_JOBS_STREAM_V1, SCRAPLING_WORKERS_GROUP } from '../queue/scrapling-contract.js';
import type {
  LensAdapter,
  LensDomLink,
  LensPageSnapshot,
  LensRelatedContent,
  LensSearchInput,
} from './lens-adapter.js';

export const LENS_RESULT_KEY_PREFIX_V1 = 'lens:result:v1:';
export const SCRAPLING_WORKER_HEARTBEAT_KEY_V1 = 'lens:worker:heartbeat:v1';

export interface ScraplingRedisAdapterOptions {
  redisUrl?: string;
  client?: RedisClientLike;
  stream?: string;
  group?: string;
  resultKeyPrefix?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  heartbeatKey?: string;
  heartbeatMaxAgeMs?: number;
}

/**
 * Adapter for the Python Scrapling worker contract.
 *
 * The TypeScript process publishes only a reference to the durable image and
 * search options. It then polls one result key until the configured overall
 * deadline. Worker failures are converted into the same LensAutomationError
 * taxonomy used by the local adapter/parser path.
 */
export class ScraplingRedisAdapter implements LensAdapter {
  public readonly name = 'scrapling' as const;
  public readonly live = true;

  private readonly client: RedisClientLike;
  private readonly ownsClient: boolean;
  private readonly stream: string;
  private readonly group: string;
  private readonly resultKeyPrefix: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatKey: string;
  private readonly heartbeatMaxAgeMs: number;

  public constructor(redisUrl: string, options?: Omit<ScraplingRedisAdapterOptions, 'redisUrl' | 'client'>);
  public constructor(options: ScraplingRedisAdapterOptions & { client: RedisClientLike });
  public constructor(
    redisUrlOrOptions: string | ScraplingRedisAdapterOptions,
    options: Omit<ScraplingRedisAdapterOptions, 'redisUrl' | 'client'> = {},
  ) {
    if (typeof redisUrlOrOptions === 'string') {
      this.client = new Redis(redisUrlOrOptions, { lazyConnect: true, maxRetriesPerRequest: null }) as unknown as RedisClientLike;
      this.ownsClient = true;
      this.stream = options.stream ?? LENS_JOBS_STREAM_V1;
      this.group = options.group ?? SCRAPLING_WORKERS_GROUP;
      this.resultKeyPrefix = options.resultKeyPrefix ?? LENS_RESULT_KEY_PREFIX_V1;
      this.timeoutMs = options.timeoutMs ?? 30_000;
      this.pollIntervalMs = options.pollIntervalMs ?? 250;
      this.heartbeatKey = options.heartbeatKey ?? SCRAPLING_WORKER_HEARTBEAT_KEY_V1;
      this.heartbeatMaxAgeMs = options.heartbeatMaxAgeMs ?? 60_000;
    } else {
      if (!redisUrlOrOptions.client) {
        if (!redisUrlOrOptions.redisUrl) throw new Error('ScraplingRedisAdapter requires redisUrl or client.');
        this.client = new Redis(redisUrlOrOptions.redisUrl, { lazyConnect: true, maxRetriesPerRequest: null }) as unknown as RedisClientLike;
        this.ownsClient = true;
      } else {
        this.client = redisUrlOrOptions.client;
        this.ownsClient = false;
      }
      this.stream = redisUrlOrOptions.stream ?? LENS_JOBS_STREAM_V1;
      this.group = redisUrlOrOptions.group ?? SCRAPLING_WORKERS_GROUP;
      this.resultKeyPrefix = redisUrlOrOptions.resultKeyPrefix ?? LENS_RESULT_KEY_PREFIX_V1;
      this.timeoutMs = redisUrlOrOptions.timeoutMs ?? 30_000;
      this.pollIntervalMs = redisUrlOrOptions.pollIntervalMs ?? 250;
      this.heartbeatKey = redisUrlOrOptions.heartbeatKey ?? SCRAPLING_WORKER_HEARTBEAT_KEY_V1;
      this.heartbeatMaxAgeMs = redisUrlOrOptions.heartbeatMaxAgeMs ?? 60_000;
    }
    if (this.timeoutMs <= 0 || this.pollIntervalMs <= 0) throw new Error('Scrapling timeouts must be positive.');
  }

  public async start(): Promise<void> {
    await connectRedis(this.client);
  }

  public async close(): Promise<void> {
    await closeRedis(this.client, this.ownsClient);
  }

  public async ready(): Promise<boolean> {
    try {
      await connectRedis(this.client);
      const raw = await requireRedisCommand(this.client, 'get')(this.heartbeatKey);
      if (!raw) return false;
      const timestamp = Number(raw);
      return Number.isFinite(timestamp) && Date.now() - timestamp <= this.heartbeatMaxAgeMs;
    } catch {
      return false;
    }
  }

  public async search(input: LensSearchInput): Promise<LensPageSnapshot> {
    const unsupportedOptions = unsupportedLiveOptions(input.options);
    if (unsupportedOptions.length > 0) {
      throw new LensAutomationError(
        'browser',
        `The live Scrapling adapter cannot apply these search options: ${unsupportedOptions.join(', ')}.`,
        false,
        { unsupported_options: unsupportedOptions },
      );
    }
    if (!input.jobId) throw new LensAutomationError('browser', 'Scrapling jobs require a jobId.', false);
    if (!input.imageId) throw new LensAutomationError('browser', 'Scrapling jobs require a durable imageId.', false);
    const attempt = input.attempt ?? 1;
    const dispatchId = input.dispatchId ?? `${input.jobId}:${attempt}`;
    const deadline = Date.now() + this.timeoutMs;
    await connectRedis(this.client);

    const resultKey = this.resultKey(input.jobId, attempt);
    // A result may have been committed by the Python worker while this API was
    // restarting. Reuse an attempt-matching result before publishing duplicate
    // work; stale results are removed only after they fail the attempt check.
    const existing = await requireRedisCommand(this.client, 'get')(resultKey);
    if (existing) {
      try {
        const mapped = mapWorkerResult(existing, input.options, attempt, input.jobId, dispatchId);
        if (mapped) return mapped;
      } catch (error) {
        if (!(error instanceof LensAutomationError) || error.code !== 'lens_parser') throw error;
      }
      if (this.client.del) await this.client.del.call(this.client, resultKey);
    }
    if (!input.dispatchPublished) {
      await requireRedisCommand(this.client, 'xadd')(
        this.stream,
        '*',
        'job_id',
        input.jobId,
        'attempt',
        String(attempt),
        'dispatch_id',
        dispatchId,
        'image_id',
        input.imageId,
        'options_json',
        JSON.stringify(input.options),
        'options',
        JSON.stringify(input.options),
      );
    }

    while (Date.now() < deadline) {
      const raw = await requireRedisCommand(this.client, 'get')(resultKey);
      if (raw) {
        const mapped = mapWorkerResult(raw, input.options, attempt, input.jobId, dispatchId);
        if (mapped) return mapped;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(this.pollIntervalMs, remaining));
    }
    throw new LensAutomationError(
      'timeout',
      `Scrapling worker did not publish a result within ${this.timeoutMs}ms.`,
      true,
      { job_id: input.jobId, result_key: resultKey },
    );
  }

  public resultKey(jobId: string, attempt = 1): string {
    return `${this.resultKeyPrefix}${jobId}:${attempt}`;
  }

  public contract(): { stream: string; group: string; resultKeyPrefix: string; fields: string[] } {
    return {
      stream: this.stream,
      group: this.group,
      resultKeyPrefix: this.resultKeyPrefix,
      fields: ['job_id', 'attempt', 'dispatch_id', 'image_id', 'options_json', 'options'],
    };
  }
}

export { ScraplingRedisAdapter as ScraplingAdapter };

function mapWorkerResult(
  raw: string,
  options: SearchOptions,
  expectedAttempt: number,
  expectedJobId: string,
  expectedDispatchId: string,
): LensPageSnapshot | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new LensAutomationError('parser', 'Scrapling worker returned invalid JSON.', false);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LensAutomationError('parser', 'Scrapling worker returned an invalid result payload.', false);
  }
  const record = payload as Record<string, unknown>;
  if (record.job_id !== expectedJobId || record.dispatch_id !== expectedDispatchId || record.attempt !== expectedAttempt) {
    return undefined;
  }
  const workerError = readWorkerError(record);
  if (workerError) throw classifyWorkerError(workerError.code, workerError.message, workerError.retryable);
  const normalizedResult = record.result;
  if (normalizedResult && isSerpApiResponse(normalizedResult)) {
    if (normalizedResult.search_metadata.status === 'Error' || normalizedResult.error) {
      throw classifyWorkerError(
        normalizedResult.error?.code ?? 'worker_error',
        normalizedResult.error?.message ?? 'Scrapling worker returned an error result.',
        false,
      );
    }
  }

  const candidate = record.snapshot ?? record.result ?? payload;
  if (isSnapshot(candidate)) return candidate;
  if (isSerpApiResponse(candidate)) return snapshotFromResult(candidate, options);
  throw new LensAutomationError('parser', 'Scrapling worker returned no snapshot or normalized result.', false);
}

interface WorkerError {
  code: string;
  message: string;
  retryable: boolean;
}

function readWorkerError(record: Record<string, unknown>): WorkerError | undefined {
  const nested = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : undefined;
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
  const failed = status === 'failed' || status === 'error' || status === 'challenge' || status === 'timeout' || Boolean(record.error);
  if (!failed) return undefined;
  const code = String(nested?.code ?? record.error_code ?? record.code ?? (status && status !== 'failed' ? status : 'worker_error'));
  const message = String(nested?.message ?? record.error_message ?? record.message ?? 'Scrapling worker failed.');
  const retryable = nested?.retryable === true || record.retryable === true || isRetryableWorkerCode(code);
  return { code, message, retryable };
}

function classifyWorkerError(code: string, message: string, retryable: boolean): LensAutomationError {
  const normalized = `${code} ${message}`.toLowerCase();
  if (/challenge|captcha|human|robot|blocked|unusual traffic/.test(normalized)) {
    return new LensAutomationError('challenge', message, false, { worker_code: code });
  }
  if (/timeout|timed out|deadline/.test(normalized)) {
    return new LensAutomationError('timeout', message, true, { worker_code: code });
  }
  if (/empty|no match|no result/.test(normalized)) {
    return new LensAutomationError('empty', message, false, { worker_code: code });
  }
  return new LensAutomationError('browser', message, retryable, { worker_code: code });
}

function isRetryableWorkerCode(code: string): boolean {
  return /timeout|temporary|unavailable|network|retry/i.test(code);
}

function isSnapshot(value: unknown): value is LensPageSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<LensPageSnapshot>;
  return (
    typeof candidate.url === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.bodyText === 'string' &&
    Array.isArray(candidate.links) &&
    typeof candidate.loading === 'boolean' &&
    typeof candidate.observedAt === 'string'
  );
}

function isSerpApiResponse(value: unknown): value is SerpApiResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<SerpApiResponse>;
  return Boolean(candidate.search_metadata && Array.isArray(candidate.visual_matches));
}

function snapshotFromResult(result: SerpApiResponse, options: SearchOptions): LensPageSnapshot {
  const links = result.visual_matches.map(toDomLink);
  const exactMatches = (result.exact_matches ?? []).map(toDomLink);
  const relatedContent: LensRelatedContent[] = (result.related_content ?? []).map((item) => ({
    query: item.query,
    ...(item.link ? { href: item.link } : {}),
    ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
  }));
  return {
    url: `redis://${LENS_RESULT_KEY_PREFIX_V1}${result.search_metadata.id}`,
    title: 'Scrapling worker result',
    bodyText: links.length || exactMatches.length ? 'Visual matches' : 'No visual matches found.',
    links: options.type === 'exact_matches' ? [] : links,
    ...(exactMatches.length > 0 ? { exactMatches } : {}),
    ...(relatedContent.length > 0 ? { relatedContent } : {}),
    loading: false,
    observedAt: result.search_metadata.processed_at || new Date().toISOString(),
  };
}

function toDomLink(match: VisualMatch): LensDomLink {
  return {
    href: match.link,
    text: match.title,
    source: match.source,
    ...(match.source_icon ? { sourceIcon: match.source_icon } : {}),
    ...(match.thumbnail ? { thumbnail: match.thumbnail } : {}),
    ...(match.image ? { image: match.image } : {}),
    ...(match.image_width !== undefined ? { imageWidth: match.image_width } : {}),
    ...(match.image_height !== undefined ? { imageHeight: match.image_height } : {}),
    ...(match.price ? { price: match.price } : {}),
    ...(match.extracted_price !== undefined ? { extractedPrice: match.extracted_price } : {}),
    ...(match.currency ? { currency: match.currency } : {}),
    ...(match.rating !== undefined ? { rating: match.rating } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unsupportedLiveOptions(options: SearchOptions): string[] {
  return [
    options.q !== undefined ? 'q' : undefined,
    options.hl !== undefined ? 'hl' : undefined,
    options.country !== undefined ? 'country' : undefined,
    options.safe !== undefined ? 'safe' : undefined,
    options.autoCrop !== undefined ? 'auto_crop' : undefined,
  ].filter((name): name is string => name !== undefined);
}
