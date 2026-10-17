import { QueueFullError } from '../domain/errors.js';
import type { ImagePayload, SearchOptions } from '../domain/types.js';
import { buildCacheKey } from './hash.js';
import { Metrics } from './metrics.js';
import { JobStore } from '../storage/job-store.js';
import { WorkerPool } from '../workers/worker-pool.js';

export class SearchService {
  public constructor(
    private readonly store: JobStore,
    private readonly workers: WorkerPool,
    private readonly metrics: Metrics,
  ) {}

  public async submit(
    image: ImagePayload,
    options: SearchOptions,
    batchId?: string,
  ): Promise<ReturnType<JobStore['createJob']>> {
    const job = this.store.createJob(image, options, batchId);
    this.store.setCacheKey(job.id, buildCacheKey(image.bytes, options));
    try {
      await this.workers.submit(job.id);
      this.metrics.increment('jobs_submitted');
      return job;
    } catch (error) {
      if (error instanceof QueueFullError) {
        this.store.fail(job.id, {
          code: error.code,
          message: error.message,
          retryable: true,
        });
      }
      throw error;
    }
  }
}
