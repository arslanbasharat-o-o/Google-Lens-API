import { Redis } from 'ioredis';

import { QueueFullError } from '../domain/errors.js';
import type { JobQueue, QueueTask } from './types.js';

/**
 * Redis list-backed queue for a single logical worker pool. The job store is
 * deliberately kept behind its own interface so a durable store can be added
 * without changing the queue protocol. Redis is not used by offline tests.
 */
export class RedisJobQueue implements JobQueue {
  private readonly client: Redis;
  private readonly blocker: Redis;
  private localDepth = 0;
  private closed = false;

  public constructor(
    redisUrl: string,
    public readonly capacity: number,
    private readonly key = 'google-lens:jobs',
  ) {
    this.client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    this.blocker = this.client.duplicate();
  }

  public async enqueue(task: QueueTask): Promise<void> {
    if (this.closed) throw new Error('Queue is closed');
    await this.client.connect().catch(ignoreAlreadyConnected);
    const depth = Number(await this.client.llen(this.key));
    if (depth >= this.capacity) throw new QueueFullError(this.capacity);
    await this.client.lpush(this.key, JSON.stringify(task));
    this.localDepth += 1;
  }

  public async dequeue(): Promise<QueueTask | undefined> {
    if (this.closed) return undefined;
    await this.blocker.connect().catch(ignoreAlreadyConnected);
    try {
      while (!this.closed) {
        const item = await this.blocker.brpop(this.key, 1);
        if (!item) continue;
        this.localDepth = Math.max(0, this.localDepth - 1);
        const parsed = JSON.parse(item[1]) as QueueTask;
        if (!parsed || typeof parsed.jobId !== 'string') continue;
        return parsed;
      }
      return undefined;
    } catch (error) {
      if (this.closed) return undefined;
      throw error;
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([this.client.quit(), this.blocker.quit()]);
  }

  public size(): number {
    return this.localDepth;
  }
}

function ignoreAlreadyConnected(error: unknown): void {
  if (!(error instanceof Error) || !/already/i.test(error.message)) throw error;
}
