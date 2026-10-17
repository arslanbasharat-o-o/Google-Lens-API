import { Redis } from 'ioredis';

import { LensAutomationError } from '../domain/errors.js';
import type { SearchOptions, SerpApiResponse, VisualMatch } from '../domain/types.js';
import {
  closeRedis,
  connectRedis,
  requireRedisCommand,
  type RedisClientLike,
} from '../storage/redis-client.js';
import {
  LENS_JOBS_STREAM_V1,
  SCRAPLING_WORKERS_GROUP,
} from '../queue/redis-streams-queue.js';
import type {
  LensAdapter,
  LensDomLink,
  LensPageSnapshot,
  LensRelatedContent,
  LensSearchInput,
} from './lens-adapter.js';

export const LENS_RESULT_KEY_PREFIX_V1 = 'lens:result:v1:';

export interface ScraplingRedisAdapterOptions {
  redisUrl?: string;
  client?: RedisClientLike;
  stream?: string;
  group?: string;
  resultKeyPrefix?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
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
    }
    if (this.timeoutMs <= 0 || this.pollIntervalMs <= 0) throw new Error('Scrapling timeouts must be positive.');
  }

  public async start(): Promise<void> {
    await connectRedis(this.client);
  }

  public async close(): Promise<void> {
    await closeRedis(this.client, this.ownsClient);
  }

  public async search(input: LensSearchInput): Promise<LensPageSnapshot> {
    if (!input.jobId) throw new LensAutomationError('browser', 'Scrapling jobs require a jobId.', false);
    if (!input.imageId) throw new LensAutomationError('browser', 'Scrapling jobs require a durable imageId.', false);
    const deadline = Date.now() + this.timeoutMs;
    await connectRedis(this.client);

    const resultKey = `${this.resultKeyPrefix}${input.jobId}`;
    // Delete only a stale result for this unique job ID. The worker result is
    // written after this publication, so a previous retry cannot be mistaken
    // for this attempt.
    if (this.client.del) await this.client.del.call(this.client, resultKey);
    await requireRedisCommand(this.client, 'xadd')(
      this.stream,
      '*',
      'job_id',
      input.jobId,
      'image_id',
      input.imageId,
      'options_json',
      JSON.stringify(input.options),
      'options',
      JSON.stringify(input.options),
    );

    while (Date.now() < deadline) {
      const raw = await requireRedisCommand(this.client, 'get')(resultKey);
      if (raw) return mapWorkerResult(raw, input.options);
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

  public resultKey(jobId: string): string {
    return `${this.resultKeyPrefix}${jobId}`;
  }

  public contract(): { stream: string; group: string; resultKeyPrefix: string; fields: string[] } {
    return {
      stream: this.stream,
      group: this.group,
      resultKeyPrefix: this.resultKeyPrefix,
      fields: ['job_id', 'image_id', 'options_json', 'options'],
    };
  }
}

export { ScraplingRedisAdapter as ScraplingAdapter };

function mapWorkerResult(raw: string, options: SearchOptions): LensPageSnapshot {
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
