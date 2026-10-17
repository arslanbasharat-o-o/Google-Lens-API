export interface QueueTask {
  jobId: string;
  /** Optional fields are carried by Redis Streams implementations. */
  imageId?: string;
  options?: Record<string, unknown>;
  attempt?: number;
  dispatchId?: string;
  /** True when a durable external worker dispatch was already published. */
  dispatchPublished?: boolean;
  streamId?: string;
}

/**
 * The service only depends on this small enqueue/dequeue contract. A Redis-
 * backed implementation can replace the in-memory implementation
 * without changing the HTTP or worker layers.
 */
export interface JobQueue {
  readonly capacity: number;
  enqueue(task: QueueTask): Promise<void>;
  dequeue(): Promise<QueueTask | undefined>;
  ack?(task: QueueTask): Promise<void>;
  close(): Promise<void>;
  size(): number;
}
