import { Redis } from 'ioredis';

import { QueueFullError } from '../domain/errors.js';
import {
  closeRedis,
  connectRedis,
  requireRedisCommand,
  type RedisClientLike,
} from '../storage/redis-client.js';
import type { JobQueue, QueueTask } from './types.js';

export const LENS_JOBS_STREAM_V1 = 'lens:jobs:v1';
export const SCRAPLING_WORKERS_GROUP = 'scrapling-workers';

export interface RedisStreamsJobQueueOptions {
  redisUrl?: string;
  client?: RedisClientLike;
  stream?: string;
  group?: string;
  consumer?: string;
  blockMs?: number;
}

/**
 * Redis Streams v1 transport contract for external Scrapling workers.
 * Messages contain references and options only; image bytes never enter Redis.
 */
export class RedisStreamsJobQueue implements JobQueue {
  public readonly capacity: number;

  private readonly client: RedisClientLike;
  private readonly ownsClient: boolean;
  private readonly stream: string;
  private readonly group: string;
  private readonly consumer: string;
  private readonly blockMs: number;
  private localDepth = 0;
  private closed = false;
  private groupPromise?: Promise<void>;

  public constructor(redisUrl: string, capacity: number, options?: Omit<RedisStreamsJobQueueOptions, 'redisUrl' | 'client'>);
  public constructor(capacity: number, options: RedisStreamsJobQueueOptions & { client: RedisClientLike });
  public constructor(
    redisUrlOrCapacity: string | number,
    capacityOrOptions: number | (RedisStreamsJobQueueOptions & { client: RedisClientLike }),
    options: Omit<RedisStreamsJobQueueOptions, 'redisUrl' | 'client'> = {},
  ) {
    if (typeof redisUrlOrCapacity === 'string') {
      this.capacity = capacityOrOptions as number;
      this.client = new Redis(redisUrlOrCapacity, { lazyConnect: true, maxRetriesPerRequest: null }) as unknown as RedisClientLike;
      this.ownsClient = true;
      this.stream = options.stream ?? LENS_JOBS_STREAM_V1;
      this.group = options.group ?? SCRAPLING_WORKERS_GROUP;
      this.consumer = options.consumer ?? `lens-api-${process.pid}`;
      this.blockMs = options.blockMs ?? 1000;
    } else {
      const supplied = capacityOrOptions as RedisStreamsJobQueueOptions & { client: RedisClientLike };
      this.capacity = redisUrlOrCapacity;
      this.client = supplied.client;
      this.ownsClient = false;
      this.stream = supplied.stream ?? LENS_JOBS_STREAM_V1;
      this.group = supplied.group ?? SCRAPLING_WORKERS_GROUP;
      this.consumer = supplied.consumer ?? `lens-api-${process.pid}`;
      this.blockMs = supplied.blockMs ?? 1000;
    }
  }

  public async enqueue(task: QueueTask): Promise<void> {
    if (this.closed) throw new Error('Queue is closed');
    if (!task.imageId) throw new Error('Redis Streams jobs require imageId.');
    await this.ensureGroup();
    const depth = await this.pendingDepth();
    if (depth >= this.capacity) throw new QueueFullError(this.capacity);
    await requireRedisCommand(this.client, 'xadd')(
      this.stream,
      '*',
      'job_id',
      task.jobId,
      'image_id',
      task.imageId,
      'options_json',
      JSON.stringify(task.options ?? {}),
      'options',
      JSON.stringify(task.options ?? {}),
    );
    this.localDepth += 1;
  }

  public async dequeue(): Promise<QueueTask | undefined> {
    if (this.closed) return undefined;
    await this.ensureGroup();
    while (!this.closed) {
      let result: unknown;
      try {
        result = await requireRedisCommand(this.client, 'xreadgroup')(
          'GROUP',
          this.group,
          this.consumer,
          'COUNT',
          1,
          'BLOCK',
          this.blockMs,
          'STREAMS',
          this.stream,
          '>',
        );
      } catch (error) {
        if (this.closed) return undefined;
        throw error;
      }
      if (!result || !Array.isArray(result)) continue;
      const message = firstStreamMessage(result);
      if (!message) continue;
      this.localDepth = Math.max(0, this.localDepth - 1);
      const fields = message.fields;
      if (!fields.job_id || !fields.image_id) {
        await this.ack({ jobId: fields.job_id ?? '', streamId: message.id });
        continue;
      }
      let options: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(fields.options_json ?? fields.options ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) options = parsed as Record<string, unknown>;
      } catch {
        await this.ack({ jobId: fields.job_id, streamId: message.id });
        continue;
      }
      return {
        jobId: fields.job_id,
        imageId: fields.image_id,
        options,
        streamId: message.id,
      };
    }
    return undefined;
  }

  public async ack(task: QueueTask): Promise<void> {
    if (this.closed || !task.streamId) return;
    await requireRedisCommand(this.client, 'xack')(this.stream, this.group, task.streamId);
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await closeRedis(this.client, this.ownsClient);
  }

  public size(): number {
    return this.localDepth;
  }

  private async pendingDepth(): Promise<number> {
    if (this.client.xpending) {
      const pending = await this.client.xpending.call(this.client, this.stream, this.group);
      if (Array.isArray(pending) && typeof pending[0] === 'number') return pending[0];
      if (typeof pending === 'number') return pending;
    }
    return this.localDepth;
  }

  private async ensureGroup(): Promise<void> {
    if (this.groupPromise) return this.groupPromise;
    this.groupPromise = (async () => {
      await connectRedis(this.client);
      try {
        await requireRedisCommand(this.client, 'xgroup')('CREATE', this.stream, this.group, '0', 'MKSTREAM');
      } catch (error) {
        if (!(error instanceof Error) || !/BUSYGROUP|already exists/i.test(error.message)) throw error;
      }
    })();
    try {
      await this.groupPromise;
    } catch (error) {
      this.groupPromise = undefined;
      throw error;
    }
  }
}

export { RedisStreamsJobQueue as RedisStreamsQueue };

interface StreamMessage {
  id: string;
  fields: Record<string, string>;
}

function firstStreamMessage(value: unknown): StreamMessage | undefined {
  // ioredis RESP2: [[stream, [[id, ['field', 'value']]]]]
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const streamEntry = value[0];
  if (!Array.isArray(streamEntry) || streamEntry.length < 2 || !Array.isArray(streamEntry[1])) return undefined;
  const rawMessage = streamEntry[1][0];
  if (!Array.isArray(rawMessage) || typeof rawMessage[0] !== 'string' || !Array.isArray(rawMessage[1])) return undefined;
  const fields: Record<string, string> = {};
  for (let index = 0; index + 1 < rawMessage[1].length; index += 2) {
    const key = rawMessage[1][index];
    const value = rawMessage[1][index + 1];
    if (typeof key === 'string' && typeof value === 'string') fields[key] = value;
  }
  return { id: rawMessage[0], fields };
}
