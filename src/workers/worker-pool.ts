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
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private startPromise?: Promise<void>;

  public constructor(
    private readonly concurrency: number,
    private readonly queue: JobQueue,
    private readonly store: JobStore,
    private readonly adapter: LensAdapter,
    private readonly parser: LensParser,
    private readonly cache: ResultCache<SerpApiResponse>,
    private readonly metrics: Metrics,
    private readonly maxAttempts = 2,
    private readonly retryBaseMs = 250,
  ) {}

  public async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      if (this.started) return;
      await this.adapter.start?.();
      this.started = true;
      for (let index = 0; index < this.concurrency; index += 1) {
        this.workers.push(this.workerLoop());
      }
    })();
    return this.startPromise;
  }

  public async submit(jobId: string): Promise<void> {
    await this.start();
    await this.queue.enqueue({ jobId });
  }

  public async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    await this.queue.close();
    await Promise.all(this.workers);
    await this.adapter.close?.();
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
    if (job.state === 'cancelled' || job.state === 'succeeded' || job.state === 'failed') return;
    const startedAt = Date.now();
    this.metrics.observe('queue_wait_ms', Math.max(0, Date.now() - Date.parse(job.createdAt)));
    const cached = job.options.noCache ? undefined : this.cache.get(job.cacheKey);
    if (cached) {
      this.metrics.increment('cache_hits');
      this.store.succeed(job.id, this.withCachedMetadata(cached, job.id));
      this.metrics.increment('jobs_succeeded');
      this.metrics.observe('job_latency_ms', Date.now() - startedAt);
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
      if (!job.options.noCache) this.cache.set(job.cacheKey, result);
      this.store.succeed(job.id, result);
      this.metrics.increment('jobs_succeeded');
      this.metrics.observe('job_latency_ms', Date.now() - startedAt);
      this.metrics.observe('adapter_latency_ms', Date.now() - startedAt);
      for (const [name, value] of Object.entries(snapshot.timings ?? {})) {
        const metricName = name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
        this.metrics.observe(metricName, value);
      }
    } catch (error) {
      const jobError = this.toJobError(error);
      if (error instanceof LensAutomationError) this.metrics.increment(`failures_${error.kind}`);
      if (jobError.retryable && job.attempts < this.maxAttempts && !this.stopping) {
        this.store.requeue(job.id);
        this.metrics.increment('jobs_retried');
        const delay = this.retryDelay(job.attempts);
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          void this.queue.enqueue({ jobId: job.id }).catch((retryError) => {
            this.store.fail(job.id, this.toJobError(retryError));
            this.metrics.increment('jobs_failed');
          });
        }, delay);
        this.retryTimers.add(timer);
      } else {
        this.store.fail(job.id, {
          ...jobError,
          ...(jobError.retryable ? { dead_letter: true } : {}),
        });
        this.metrics.increment('jobs_failed');
        if (jobError.retryable) this.metrics.increment('jobs_dead_lettered');
      }
      this.metrics.observe('job_latency_ms', Date.now() - startedAt);
    }
  }

  private retryDelay(attempt: number): number {
    const jitter = Math.floor(Math.random() * Math.max(1, this.retryBaseMs));
    return this.retryBaseMs * 2 ** Math.max(0, attempt - 1) + jitter;
  }

  private withCachedMetadata(result: SerpApiResponse, jobId: string): SerpApiResponse {
    return {
      ...result,
      search_metadata: {
        ...result.search_metadata,
        id: jobId,
        json_endpoint: `/v1/jobs/${jobId}`,
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
