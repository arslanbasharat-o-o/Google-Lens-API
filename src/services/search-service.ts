import { QueueFullError } from '../domain/errors.js';
import type { ImagePayload, SearchOptions, SerpApiResponse } from '../domain/types.js';
import { buildCacheKey } from './hash.js';
import { Metrics } from './metrics.js';
import type { ResultCache } from './cache.js';
import { JobStore } from '../storage/job-store.js';
import { WorkerPool } from '../workers/worker-pool.js';
import type { ImageStoreContract } from '../storage/image-store.js';

export class SearchService {
  public constructor(
    private readonly store: JobStore,
    private readonly workers: WorkerPool,
    private readonly metrics: Metrics,
    private readonly imageStore: ImageStoreContract,
    private readonly cache: ResultCache<SerpApiResponse>,
  ) {}

  public async submit(
    image: ImagePayload,
    options: SearchOptions,
    batchId?: string,
    principal?: string,
  ): Promise<ReturnType<JobStore['createJob']>> {
    const stored = this.imageStore.put(image, principal);
    const cacheKey = buildCacheKey(image.bytes, options, principal ?? 'public');
    const job = this.store.createJob(
      { ...image, bytes: Buffer.alloc(0) },
      options,
      batchId,
      stored.imageId,
      principal,
    );
    this.store.setCacheKey(job.id, cacheKey);
    // A request is not accepted until the job, batch membership, image lease,
    // and cache key are durably persisted. This also makes a crash between
    // admission and the local dispatcher recoverable from Redis on restart.
    await this.store.flush();
    const cached = options.noCache ? undefined : this.cache.get(cacheKey);
    if (cached) {
      this.metrics.increment('cache_hits');
      this.store.succeed(job.id, this.withCachedMetadata(cached, job.id));
      return this.store.requireJob(job.id);
    }
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
        await this.store.flush();
      }
      throw error;
    }
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
}
