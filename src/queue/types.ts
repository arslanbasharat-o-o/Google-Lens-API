export interface QueueTask {
  jobId: string;
}

/**
 * The service only depends on this small enqueue/dequeue contract. A BullMQ
 * or Redis-backed implementation can replace the in-memory implementation
 * without changing the HTTP or worker layers.
 */
export interface JobQueue {
  readonly capacity: number;
  enqueue(task: QueueTask): Promise<void>;
  dequeue(): Promise<QueueTask | undefined>;
  close(): Promise<void>;
  size(): number;
}
