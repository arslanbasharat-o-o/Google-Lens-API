import { Redis } from 'ioredis';

import { QueueFullError } from '../domain/errors.js';
import {
  closeRedis,
  connectRedis,
  requireRedisCommand,
  type RedisClientLike,
} from '../storage/redis-client.js';
import { InMemoryJobQueue } from './in-memory-queue.js';
import { LENS_JOBS_STREAM_V1 } from './scrapling-contract.js';
import type { JobQueue, QueueTask } from './types.js';

/**
 * Durable admission for the external Python worker.
 *
 * Redis is the accepted-work boundary; the local queue only controls how many
 * already-published jobs the Fastify process polls concurrently. On restart,
 * hydrated jobs are published again with the same dispatch id and the worker
 * result ownership rule makes that duplicate safe.
 */
export class ScraplingDispatchQueue implements JobQueue {
  private readonly local: InMemoryJobQueue;
  private readonly client: RedisClientLike;
  private readonly ownsClient: boolean;
  private readonly stream: string;
  private reservations = 0;
  private closed = false;

  public constructor(redisUrl: string, capacity: number, stream?: string);
  public constructor(capacity: number, options: { client: RedisClientLike; stream?: string });
  public constructor(
    redisUrlOrCapacity: string | number,
    capacityOrOptions: number | { client: RedisClientLike; stream?: string },
    stream = LENS_JOBS_STREAM_V1,
  ) {
    if (typeof redisUrlOrCapacity === 'string') {
      this.local = new InMemoryJobQueue(capacityOrOptions as number);
      this.client = new Redis(redisUrlOrCapacity, { lazyConnect: true, maxRetriesPerRequest: null }) as unknown as RedisClientLike;
      this.ownsClient = true;
      this.stream = stream;
    } else {
      const options = capacityOrOptions as { client: RedisClientLike; stream?: string };
      this.local = new InMemoryJobQueue(redisUrlOrCapacity);
      this.client = options.client;
      this.ownsClient = false;
      this.stream = options.stream ?? LENS_JOBS_STREAM_V1;
    }
  }

  public get capacity(): number {
    return this.local.capacity;
  }

  public async enqueue(task: QueueTask): Promise<void> {
    if (this.closed) throw new Error('Queue is closed');
    if (!task.imageId || !task.options || !task.attempt || task.attempt < 1) {
      throw new Error('Scrapling dispatch requires imageId, options, and a positive attempt.');
    }
    if (this.local.size() + this.reservations >= this.capacity) throw new QueueFullError(this.capacity);
    this.reservations += 1;
    try {
      const dispatchId = task.dispatchId ?? `${task.jobId}:${task.attempt}`;
      await connectRedis(this.client);
      await requireRedisCommand(this.client, 'xadd')(
        this.stream,
        '*',
        'job_id',
        task.jobId,
        'attempt',
        String(task.attempt),
        'dispatch_id',
        dispatchId,
        'image_id',
        task.imageId,
        'options_json',
        JSON.stringify(task.options),
        'options',
        JSON.stringify(task.options),
      );
      await this.local.enqueue({ ...task, dispatchId, dispatchPublished: true });
    } finally {
      this.reservations -= 1;
    }
  }

  public dequeue(): Promise<QueueTask | undefined> {
    return this.local.dequeue();
  }

  public size(): number {
    return this.local.size();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.local.close();
    await closeRedis(this.client, this.ownsClient);
  }
}
