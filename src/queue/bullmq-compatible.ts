import type { QueueTask } from './types.js';

/**
 * Optional producer seam for a BullMQ/Redis deployment. The default service
 * uses InMemoryJobQueue so tests and local runs stay dependency-free. A host
 * application can pass a BullMQ Queue object (or a compatible wrapper) here
 * and run workers that translate the same QueueTask payload.
 */
export interface BullMqQueueLike {
  add(
    name: string,
    data: QueueTask,
    options?: {
      attempts?: number;
      removeOnComplete?: number;
      removeOnFail?: number;
    },
  ): Promise<unknown>;
}

export class BullMqEnqueueBoundary {
  public constructor(private readonly queue: BullMqQueueLike) {}

  public async enqueue(task: QueueTask): Promise<void> {
    await this.queue.add('lens.search', task, {
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
  }
}
