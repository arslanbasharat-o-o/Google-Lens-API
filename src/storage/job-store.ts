import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../domain/errors.js';
import type {
  BatchRecord,
  ImagePayload,
  JobError,
  JobRecord,
  JobState,
  PublicBatchRecord,
  PublicJobRecord,
  SearchOptions,
  SerpApiResponse,
} from '../domain/types.js';
import type { JobPersistence } from './job-persistence.js';
import type { ImageStoreContract } from './image-store.js';

export type { JobPersistence } from './job-persistence.js';

type TerminalListener = (job: JobRecord) => void;

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly batches = new Map<string, BatchRecord>();
  private readonly listeners = new Map<string, Set<TerminalListener>>();
  private readonly pendingPersistence = new Set<Promise<void>>();
  private readonly persistenceChains = new Map<string, Promise<void>>();

  public constructor(
    private readonly maxRecords: number,
    private readonly retentionMs: number,
    private readonly now: () => number = Date.now,
    private readonly persistence?: JobPersistence,
    private readonly imageStore?: ImageStoreContract,
  ) {}

  /** Restore durable jobs before the worker pool starts consuming work. */
  public async hydrate(): Promise<void> {
    if (!this.persistence) return;
    const snapshot = await this.persistence.hydrate();
    for (const batch of snapshot.batches) this.batches.set(batch.id, batch);
    for (const job of snapshot.jobs) this.jobs.set(job.id, job);
    for (const job of snapshot.jobs) {
      if ((job.state === 'queued' || job.state === 'running') && job.imageId) {
        try {
          this.imageStore?.ensureLease(job.imageId);
        } catch {
          // The job remains visible and will fail explicitly when its image is
          // requested; hydration must not silently delete durable metadata.
        }
      }
    }
    this.prune();
  }

  public async flush(): Promise<void> {
    await Promise.all([...this.pendingPersistence]);
    await this.persistence?.flush();
  }

  public recoverableJobs(): JobRecord[] {
    return [...this.jobs.values()].filter((job) => job.state === 'queued' || job.state === 'running');
  }

  public createBatch(principal?: string): BatchRecord {
    this.prune();
    const now = new Date(this.now()).toISOString();
    const batch: BatchRecord = {
      id: randomUUID(),
      ...(principal ? { principal } : {}),
      jobIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.batches.set(batch.id, batch);
    this.persistBatch(batch);
    return batch;
  }

  public createJob(
    image: ImagePayload,
    options: SearchOptions,
    batchId?: string,
    imageId?: string,
    principal?: string,
  ): JobRecord {
    if (batchId && !this.batches.has(batchId)) {
      throw new NotFoundError('batch', batchId);
    }
    this.prune();
    const now = new Date(this.now()).toISOString();
    const job: JobRecord = {
      id: randomUUID(),
      batchId,
      ...(principal ? { principal } : {}),
      cacheKey: '',
      ...(imageId ? { imageId } : {}),
      image,
      options,
      state: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    if (imageId) this.imageStore?.retain(imageId);
    if (batchId) {
      const batch = this.batches.get(batchId);
      batch?.jobIds.push(job.id);
      if (batch) batch.updatedAt = now;
      this.persistBatch(batch);
    }
    this.persist(job);
    return job;
  }

  public setCacheKey(id: string, cacheKey: string): JobRecord {
    const job = this.requireJob(id);
    job.cacheKey = cacheKey;
    job.updatedAt = this.isoNow();
    this.persist(job);
    return job;
  }

  public getJob(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  public requireJob(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundError('job', id);
    return job;
  }

  public requireVisibleJob(id: string, principal?: string): JobRecord {
    const job = this.requireJob(id);
    if (job.principal && job.principal !== principal) throw new NotFoundError('job', id);
    return job;
  }

  public getBatch(id: string): BatchRecord | undefined {
    return this.batches.get(id);
  }

  public requireVisibleBatch(id: string, principal?: string): BatchRecord {
    const batch = this.getBatch(id);
    if (!batch || (batch.principal && batch.principal !== principal)) throw new NotFoundError('batch', id);
    return batch;
  }

  public markRunning(id: string): JobRecord {
    const job = this.requireJob(id);
    if (job.state === 'cancelled' || job.state === 'succeeded' || job.state === 'failed' || job.state === 'running') return job;
    job.state = 'running';
    job.attempts += 1;
    job.startedAt = this.isoNow();
    job.updatedAt = job.startedAt;
    this.persist(job);
    return job;
  }

  public succeed(id: string, result: SerpApiResponse): JobRecord {
    const job = this.requireJob(id);
    if (job.state === 'cancelled' || job.state === 'succeeded' || job.state === 'failed') return job;
    job.state = 'succeeded';
    job.result = result;
    job.error = undefined;
    job.finishedAt = this.isoNow();
    job.updatedAt = job.finishedAt;
    this.releaseImage(job);
    this.notifyTerminal(job);
    this.persist(job, true);
    return job;
  }

  public fail(id: string, error: JobError): JobRecord {
    const job = this.requireJob(id);
    if (job.state === 'cancelled' || job.state === 'succeeded' || job.state === 'failed') return job;
    job.state = 'failed';
    job.error = error;
    job.finishedAt = this.isoNow();
    job.updatedAt = job.finishedAt;
    this.releaseImage(job);
    this.notifyTerminal(job);
    this.persist(job, true);
    return job;
  }

  public requeue(id: string): JobRecord {
    const job = this.requireJob(id);
    if (job.state === 'cancelled' || job.state === 'succeeded' || job.state === 'failed') return job;
    job.state = 'queued';
    job.startedAt = undefined;
    job.updatedAt = this.isoNow();
    this.persist(job);
    return job;
  }

  public cancel(id: string): JobRecord {
    const job = this.requireJob(id);
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') return job;
    job.state = 'cancelled';
    job.cancelledAt = this.isoNow();
    job.finishedAt = job.cancelledAt;
    job.updatedAt = job.cancelledAt;
    this.releaseImage(job);
    this.notifyTerminal(job);
    this.persist(job, true);
    return job;
  }

  public async waitForTerminal(id: string, timeoutMs: number): Promise<JobRecord | undefined> {
    const current = this.requireJob(id);
    if (current.state === 'succeeded' || current.state === 'failed' || current.state === 'cancelled') return current;
    if (timeoutMs <= 0) return undefined;

    return new Promise<JobRecord | undefined>((resolve) => {
      let settled = false;
      const listener: TerminalListener = (job) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.get(id)?.delete(listener);
        resolve(job);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.listeners.get(id)?.delete(listener);
        resolve(undefined);
      }, timeoutMs);
      const listeners = this.listeners.get(id) ?? new Set<TerminalListener>();
      listeners.add(listener);
      this.listeners.set(id, listeners);
    });
  }

  public toPublicJob(job: JobRecord): PublicJobRecord {
    return {
      id: job.id,
      ...(job.batchId ? { batch_id: job.batchId } : {}),
      status: job.state,
      attempts: job.attempts,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
      ...(job.startedAt ? { started_at: job.startedAt } : {}),
      ...(job.finishedAt ? { finished_at: job.finishedAt } : {}),
      ...(job.cancelledAt ? { cancelled_at: job.cancelledAt } : {}),
      cache_key: job.cacheKey,
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
      status_url: `/v1/jobs/${job.id}`,
    };
  }

  public toPublicBatch(batch: BatchRecord): PublicBatchRecord {
    const jobs = batch.jobIds
      .map((jobId) => this.jobs.get(jobId))
      .filter((job): job is JobRecord => job !== undefined);
    const counts: Record<JobState, number> = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const job of jobs) counts[job.state] += 1;
    const retryPending = jobs.some((job) => job.state === 'queued' && job.attempts > 0);
    const status =
      jobs.length === 0
        ? 'queued'
        : retryPending
        ? 'retry_pending'
        : counts.queued > 0 || counts.running > 0
          ? counts.running > 0 || counts.succeeded > 0 || counts.failed > 0 || counts.cancelled > 0
            ? 'running'
            : 'queued'
          : counts.cancelled === jobs.length && jobs.length > 0
            ? 'cancelled'
            : counts.succeeded === jobs.length && jobs.length > 0
              ? 'completed'
              : counts.succeeded > 0
                ? 'completed_with_errors'
                : 'failed';
    return {
      id: batch.id,
      status,
      created_at: batch.createdAt,
      updated_at: batch.updatedAt,
      counts,
      jobs: jobs.map((job) => this.toPublicJob(job)),
    };
  }

  public size(): number {
    return this.jobs.size;
  }

  private notifyTerminal(job: JobRecord): void {
    const listeners = this.listeners.get(job.id);
    if (listeners) {
      this.listeners.delete(job.id);
      for (const listener of listeners) listener(job);
    }
    if (job.batchId) {
      const batch = this.batches.get(job.batchId);
      if (batch) {
        batch.updatedAt = job.updatedAt;
        this.persistBatch(batch);
      }
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      if (
        (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') &&
        new Date(job.updatedAt).getTime() < cutoff
      ) {
        this.jobs.delete(id);
        this.persistDeleteJob(id);
      }
    }
    for (const [id, batch] of this.batches) {
      const allTerminal = batch.jobIds.every((jobId) => {
        const job = this.jobs.get(jobId);
        return !job || job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled';
      });
      if (allTerminal && new Date(batch.updatedAt).getTime() < cutoff) {
        this.batches.delete(id);
        this.persistDeleteBatch(id);
      }
    }
    if (this.jobs.size <= this.maxRecords) return;
    const candidates = [...this.jobs.values()]
      .filter((job) => job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const job of candidates) {
      if (this.jobs.size <= this.maxRecords) break;
      this.jobs.delete(job.id);
      this.persistDeleteJob(job.id);
    }
  }

  private persist(job: JobRecord, terminal = false): void {
    if (!this.persistence) return;
    this.schedulePersistence(`job:${job.id}`, () => this.persistence!.saveJob(job, { terminal }));
  }

  private persistBatch(batch: BatchRecord | undefined): void {
    if (!this.persistence || !batch) return;
    this.schedulePersistence(`batch:${batch.id}`, () => this.persistence!.saveBatch(batch));
  }

  private persistDeleteJob(id: string): void {
    if (!this.persistence) return;
    this.schedulePersistence(`job:${id}`, () => this.persistence!.deleteJob(id));
  }

  private persistDeleteBatch(id: string): void {
    if (!this.persistence) return;
    this.schedulePersistence(`batch:${id}`, () => this.persistence!.deleteBatch(id));
  }

  private schedulePersistence(key: string, operationFactory: () => Promise<void>): void {
    const previous = this.persistenceChains.get(key) ?? Promise.resolve();
    const operation = previous
      .then(operationFactory)
    this.persistenceChains.set(key, operation);
    this.pendingPersistence.add(operation);
    const cleanup = (): void => {
      this.pendingPersistence.delete(operation);
      if (this.persistenceChains.get(key) === operation) this.persistenceChains.delete(key);
    };
    void operation.then(cleanup, cleanup);
  }

  private releaseImage(job: JobRecord): void {
    // Completed jobs retain hashes and metadata for cache/status inspection,
    // but not the uploaded bytes. This prevents the status store from
    // extending the lifetime of potentially large request bodies.
    job.image.bytes = Buffer.alloc(0);
    if (job.imageId) this.imageStore?.release(job.imageId);
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}
