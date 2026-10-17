import { LensAutomationError, ServiceError } from '../domain/errors.js';
import type { JobError, JobRecord, SerpApiResponse } from '../domain/types.js';
import type { LensAdapter } from '../adapters/lens-adapter.js';
import type { LensParser } from '../parser/lens-parser.js';
import type { ResultCache } from '../services/cache.js';
import { Metrics } from '../services/metrics.js';
import { JobStore } from '../storage/job-store.js';
import type { JobQueue } from '../queue/types.js';

export class WorkerPool {
  private readonly workers: Promise<void>[] = [];
  private running = 0;
  private started = false;
  private stopping = false;

  public constructor(
    private readonly concurrency: number,
    private readonly queue: JobQueue,
    private readonly store: JobStore,
    private readonly adapter: LensAdapter,
    private readonly parser: LensParser,
    private readonly cache: ResultCache<SerpApiResponse>,
    private readonly metrics: Metrics,
  ) {}

  public start(): void {
    if (this.started) return;
    this.started = true;
    for (let index = 0; index < this.concurrency; index += 1) {
      this.workers.push(this.workerLoop());
    }
  }

  public async submit(jobId: string): Promise<void> {
    if (!this.started) this.start();
    await this.queue.enqueue({ jobId });
  }

  public async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.queue.close();
    await Promise.all(this.workers);
  }

  public queueDepth(): number {
    return this.queue.size();
  }

  public runningCount(): number {
    return this.running;
  }

  private async workerLoop(): Promise<void> {
    while (!this.stopping) {
      const task = await this.queue.dequeue();
      if (!task) return;
      this.running += 1;
      try {
        await this.process(task.jobId);
      } finally {
        this.running -= 1;
      }
    }
  }

  private async process(jobId: string): Promise<void> {
    let job: JobRecord;
    try {
      job = this.store.markRunning(jobId);
    } catch {
      return;
    }
    const startedAt = Date.now();
    const cached = this.cache.get(job.cacheKey);
    if (cached) {
      this.metrics.increment('cache_hits');
      this.store.succeed(job.id, this.withCachedMetadata(cached));
      this.metrics.increment('jobs_succeeded');
      return;
    }

    try {
      const snapshot = await this.adapter.search({
        image: job.image.bytes,
        mimeType: job.image.mimeType,
        ...(job.image.originalName ? { originalName: job.image.originalName } : {}),
        options: job.options,
      });
      const processedAt = Date.now();
      const result = this.parser.parse(snapshot, {
        jobId: job.id,
        options: job.options,
        startedAt,
        processedAt,
        source: this.adapter.name,
      });
      this.cache.set(job.cacheKey, result);
      this.store.succeed(job.id, result);
      this.metrics.increment('jobs_succeeded');
    } catch (error) {
      this.store.fail(job.id, this.toJobError(error));
      this.metrics.increment('jobs_failed');
    }
  }

  private withCachedMetadata(result: SerpApiResponse): SerpApiResponse {
    return {
      ...result,
      search_metadata: {
        ...result.search_metadata,
        cached: true,
        processed_at: new Date().toISOString(),
      },
    };
  }

  private toJobError(error: unknown): JobError {
    if (error instanceof LensAutomationError) {
      return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        failure_kind: error.kind,
      };
    }
    if (error instanceof ServiceError) {
      return { code: error.code, message: error.message, retryable: error.retryable };
    }
    return {
      code: 'worker_error',
      message: error instanceof Error ? error.message : 'Unknown worker error',
      retryable: true,
    };
  }
}
