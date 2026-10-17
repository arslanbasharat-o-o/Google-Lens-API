import { Redis } from 'ioredis';

import type {
  BatchRecord,
  ImagePayload,
  JobError,
  JobRecord,
  JobState,
  SearchOptions,
  SerpApiResponse,
} from '../domain/types.js';
import {
  closeRedis,
  connectRedis,
  requireRedisCommand,
  type RedisClientLike,
} from './redis-client.js';

export interface JobPersistenceSnapshot {
  jobs: JobRecord[];
  batches: BatchRecord[];
}

export interface JobPersistence {
  hydrate(): Promise<JobPersistenceSnapshot>;
  saveJob(job: JobRecord, options?: { terminal?: boolean }): Promise<void>;
  saveBatch(batch: BatchRecord): Promise<void>;
  deleteJob(jobId: string): Promise<void>;
  deleteBatch(batchId: string): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface RedisJobPersistenceOptions {
  redisUrl?: string;
  client?: RedisClientLike;
  keyPrefix?: string;
}

const terminalCommitScript = `
local current = redis.call('GET', KEYS[1])
if current then
  local previous = cjson.decode(current)
  local incoming = cjson.decode(ARGV[1])
  local previousState = previous['state']
  local incomingState = incoming['state']
  if previousState == 'cancelled' and incomingState ~= 'cancelled' then return 0 end
  if previousState == 'succeeded' or previousState == 'failed' then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[2])
return 1
`;

/**
 * Redis persistence for restart-safe status and result inspection.
 *
 * Job payloads intentionally persist image metadata and imageId only; image
 * bytes stay in FileImageStore. Terminal writes use a Redis Lua compare-and-set
 * so a late worker result cannot replace a cancelled/succeeded job in another
 * API process.
 */
export class RedisJobPersistence implements JobPersistence {
  private readonly client: RedisClientLike;
  private readonly ownsClient: boolean;
  private readonly prefix: string;

  public constructor(redisUrl: string, options?: Omit<RedisJobPersistenceOptions, 'redisUrl' | 'client'>);
  public constructor(options: RedisJobPersistenceOptions);
  public constructor(
    redisUrlOrOptions: string | RedisJobPersistenceOptions,
    options: Omit<RedisJobPersistenceOptions, 'redisUrl' | 'client'> = {},
  ) {
    if (typeof redisUrlOrOptions === 'string') {
      this.client = new Redis(redisUrlOrOptions, { lazyConnect: true, maxRetriesPerRequest: null }) as unknown as RedisClientLike;
      this.ownsClient = true;
      this.prefix = normalizePrefix(options.keyPrefix);
    } else {
      if (!redisUrlOrOptions.client) {
        if (!redisUrlOrOptions.redisUrl) throw new Error('RedisJobPersistence requires redisUrl or client.');
        this.client = new Redis(redisUrlOrOptions.redisUrl, { lazyConnect: true, maxRetriesPerRequest: null }) as unknown as RedisClientLike;
        this.ownsClient = true;
      } else {
        this.client = redisUrlOrOptions.client;
        this.ownsClient = false;
      }
      this.prefix = normalizePrefix(redisUrlOrOptions.keyPrefix);
    }
  }

  public async hydrate(): Promise<JobPersistenceSnapshot> {
    await connectRedis(this.client);
    const jobs = await this.readIndexedJobs();
    const batches = await this.readIndexedBatches();
    return { jobs, batches };
  }

  public async saveJob(job: JobRecord, options: { terminal?: boolean } = {}): Promise<void> {
    await connectRedis(this.client);
    const serialized = serializeJob(job);
    if (this.client.eval) {
      await this.client.eval(
        terminalCommitScript,
        2,
        this.jobKey(job.id),
        this.jobsIndexKey(),
        serialized,
        job.id,
      );
      if (job.state === 'cancelled') await this.markCancelled(job.id);
      return;
    }

    // Fakes and constrained Redis-compatible services may not expose EVAL. The
    // fallback still refuses terminal overwrites in a single process.
    if (options.terminal) {
      const current = await requireRedisCommand(this.client, 'get')(this.jobKey(job.id));
      if (current && terminalState(JSON.parse(current)) !== undefined) return;
    }
    await requireRedisCommand(this.client, 'set')(this.jobKey(job.id), serialized);
    await requireRedisCommand(this.client, 'sadd')(this.jobsIndexKey(), job.id);
    if (job.state === 'cancelled') await this.markCancelled(job.id);
  }

  public async saveBatch(batch: BatchRecord): Promise<void> {
    await connectRedis(this.client);
    await requireRedisCommand(this.client, 'set')(this.batchKey(batch.id), JSON.stringify(batch));
    await requireRedisCommand(this.client, 'sadd')(this.batchesIndexKey(), batch.id);
  }

  public async deleteJob(jobId: string): Promise<void> {
    await connectRedis(this.client);
    await requireRedisCommand(this.client, 'del')(this.jobKey(jobId));
    await requireRedisCommand(this.client, 'srem')(this.jobsIndexKey(), jobId);
  }

  public async deleteBatch(batchId: string): Promise<void> {
    await connectRedis(this.client);
    await requireRedisCommand(this.client, 'del')(this.batchKey(batchId));
    await requireRedisCommand(this.client, 'srem')(this.batchesIndexKey(), batchId);
  }

  public async flush(): Promise<void> {
    // Commands are awaited at each call site. This method gives JobStore a
    // stable lifecycle seam and remains intentionally cheap.
  }

  public async close(): Promise<void> {
    await closeRedis(this.client, this.ownsClient);
  }

  private async readIndexedJobs(): Promise<JobRecord[]> {
    const ids = await requireRedisCommand(this.client, 'smembers')(this.jobsIndexKey());
    const jobs: JobRecord[] = [];
    for (const id of ids) {
      const value = await requireRedisCommand(this.client, 'get')(this.jobKey(id));
      if (!value) continue;
      const parsed = parseJob(value);
      if (parsed) jobs.push(parsed);
    }
    return jobs;
  }

  private async readIndexedBatches(): Promise<BatchRecord[]> {
    const ids = await requireRedisCommand(this.client, 'smembers')(this.batchesIndexKey());
    const batches: BatchRecord[] = [];
    for (const id of ids) {
      const value = await requireRedisCommand(this.client, 'get')(this.batchKey(id));
      if (!value) continue;
      const parsed = parseBatch(value);
      if (parsed) batches.push(parsed);
    }
    return batches;
  }

  private jobKey(jobId: string): string {
    return `${this.prefix}job:v1:${jobId}`;
  }

  private batchKey(batchId: string): string {
    return `${this.prefix}batch:v1:${batchId}`;
  }

  private jobsIndexKey(): string {
    return `${this.prefix}jobs:v1:index`;
  }

  private batchesIndexKey(): string {
    return `${this.prefix}batches:v1:index`;
  }

  private cancelKey(jobId: string): string {
    return `${this.prefix}cancel:v1:${jobId}`;
  }

  private async markCancelled(jobId: string): Promise<void> {
    // Keep the marker longer than a normal result so a worker that is
    // reclaimed after a process restart still cannot publish late work.
    await requireRedisCommand(this.client, 'set')(this.cancelKey(jobId), '1', 'EX', 86_400);
  }
}

// A descriptive alias is useful to callers that use "store" terminology.
export { RedisJobPersistence as RedisJobStore };
export { RedisJobPersistence as RedisBackedJobPersistence };

function normalizePrefix(prefix: string | undefined): string {
  const value = prefix?.trim() || 'lens:';
  return value.endsWith(':') ? value : `${value}:`;
}

function serializeJob(job: JobRecord): string {
  const image: ImagePayload = {
    ...job.image,
    // Persist only metadata. FileImageStore is the durable byte boundary.
    bytes: Buffer.alloc(0),
  };
  return JSON.stringify({ ...job, image, ...(job.imageId ? { imageId: job.imageId } : {}) });
}

function parseJob(raw: string): JobRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<JobRecord> & { image?: Partial<ImagePayload> };
    if (
      typeof value.id !== 'string' ||
      typeof value.cacheKey !== 'string' ||
      !isJobState(value.state) ||
      typeof value.attempts !== 'number' ||
      typeof value.createdAt !== 'string' ||
      typeof value.updatedAt !== 'string' ||
      !value.image ||
      typeof value.image.sha256 !== 'string' ||
      typeof value.image.mimeType !== 'string' ||
      typeof value.image.size !== 'number' ||
      !value.options
    ) return undefined;
    const image: ImagePayload = {
      bytes: decodeBytes(value.image.bytes),
      mimeType: value.image.mimeType as ImagePayload['mimeType'],
      sha256: value.image.sha256,
      size: value.image.size,
      ...(value.image.originalName ? { originalName: value.image.originalName } : {}),
      ...(value.image.width !== undefined ? { width: value.image.width } : {}),
      ...(value.image.height !== undefined ? { height: value.image.height } : {}),
    };
    return {
      id: value.id,
      ...(value.batchId ? { batchId: value.batchId } : {}),
      ...(value.principal ? { principal: value.principal } : {}),
      cacheKey: value.cacheKey,
      ...(value.imageId ? { imageId: value.imageId } : {}),
      image,
      options: value.options as SearchOptions,
      state: value.state,
      attempts: value.attempts,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      ...(value.startedAt ? { startedAt: value.startedAt } : {}),
      ...(value.finishedAt ? { finishedAt: value.finishedAt } : {}),
      ...(value.result ? { result: value.result as SerpApiResponse } : {}),
      ...(value.error ? { error: value.error as JobError } : {}),
      ...(value.cancelledAt ? { cancelledAt: value.cancelledAt } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseBatch(raw: string): BatchRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<BatchRecord>;
    if (
      typeof value.id !== 'string' ||
      !Array.isArray(value.jobIds) ||
      !value.jobIds.every((id): id is string => typeof id === 'string') ||
      typeof value.createdAt !== 'string' ||
      typeof value.updatedAt !== 'string'
    ) return undefined;
    return {
      id: value.id,
      ...(value.principal ? { principal: value.principal } : {}),
      jobIds: [...value.jobIds],
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  } catch {
    return undefined;
  }
}

function decodeBytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (
    value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'Buffer' &&
    'data' in value &&
    Array.isArray(value.data)
  ) return Buffer.from(value.data as number[]);
  return Buffer.alloc(0);
}

function isJobState(value: unknown): value is JobState {
  return value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled';
}

function terminalState(value: { state?: unknown }): JobState | undefined {
  return value.state === 'succeeded' || value.state === 'failed' || value.state === 'cancelled'
    ? value.state
    : undefined;
}
