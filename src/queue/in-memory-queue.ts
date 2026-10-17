import { QueueFullError } from '../domain/errors.js';
import type { JobQueue, QueueTask } from './types.js';

type Resolver = (task: QueueTask | undefined) => void;

export class InMemoryJobQueue implements JobQueue {
  private readonly items: QueueTask[] = [];
  private readonly waiters: Resolver[] = [];
  private closed = false;

  public constructor(public readonly capacity: number) {}

  public async enqueue(task: QueueTask): Promise<void> {
    if (this.closed) throw new Error('Queue is closed');
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(task);
      return;
    }
    if (this.items.length >= this.capacity) {
      throw new QueueFullError(this.capacity);
    }
    this.items.push(task);
  }

  public async dequeue(): Promise<QueueTask | undefined> {
    const item = this.items.shift();
    if (item) return item;
    if (this.closed) return undefined;
    return new Promise<QueueTask | undefined>((resolve) => this.waiters.push(resolve));
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.items.length = 0;
    for (const resolve of this.waiters.splice(0)) resolve(undefined);
  }

  public size(): number {
    return this.items.length;
  }
}
