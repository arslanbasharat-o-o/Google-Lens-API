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

type TerminalListener = (job: JobRecord) => void;

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly batches = new Map<string, BatchRecord>();
  private readonly listeners = new Map<string, Set<TerminalListener>>();

  public constructor(
    private readonly maxRecords: number,
    private readonly retentionMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  public createBatch(): BatchRecord {
    this.prune();
    const now = new Date(this.now()).toISOString();
    const batch: BatchRecord = { id: randomUUID(), jobIds: [], createdAt: now, updatedAt: now };
    this.batches.set(batch.id, batch);
    return batch;
  }

  public createJob(image: ImagePayload, options: SearchOptions, batchId?: string): JobRecord {
    if (batchId && !this.batches.has(batchId)) {
      throw new NotFoundError('batch', batchId);
    }
    this.prune();
    const now = new Date(this.now()).toISOString();
    const job: JobRecord = {
      id: randomUUID(),
      batchId,
      cacheKey: '',
      image,
      options,
      state: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    if (batchId) {
      const batch = this.batches.get(batchId);
      batch?.jobIds.push(job.id);
      if (batch) batch.updatedAt = now;
    }
    return job;
  }

  public setCacheKey(id: string, cacheKey: string): JobRecord {
    const job = this.requireJob(id);
    job.cacheKey = cacheKey;
    job.updatedAt = this.isoNow();
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

  public getBatch(id: string): BatchRecord | undefined {
    return this.batches.get(id);
  }

  public markRunning(id: string): JobRecord {
    const job = this.requireJob(id);
    job.state = 'running';
    job.attempts += 1;
    job.startedAt = this.isoNow();
    job.updatedAt = job.startedAt;
    return job;
  }

  public succeed(id: string, result: SerpApiResponse): JobRecord {
    const job = this.requireJob(id);
    job.state = 'succeeded';
    job.result = result;
    job.error = undefined;
    job.finishedAt = this.isoNow();
    job.updatedAt = job.finishedAt;
    this.releaseImage(job);
    this.notifyTerminal(job);
    return job;
  }

  public fail(id: string, error: JobError): JobRecord {
    const job = this.requireJob(id);
    job.state = 'failed';
    job.error = error;
    job.finishedAt = this.isoNow();
    job.updatedAt = job.finishedAt;
    this.releaseImage(job);
    this.notifyTerminal(job);
    return job;
  }

  public async waitForTerminal(id: string, timeoutMs: number): Promise<JobRecord | undefined> {
    const current = this.requireJob(id);
    if (current.state === 'succeeded' || current.state === 'failed') return current;
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
    };
    for (const job of jobs) counts[job.state] += 1;
    const status =
      counts.failed > 0
        ? 'failed'
        : counts.succeeded === jobs.length && jobs.length > 0
          ? 'completed'
          : counts.running > 0 || counts.succeeded > 0
            ? 'running'
            : 'queued';
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
    if (!listeners) return;
    this.listeners.delete(job.id);
    for (const listener of listeners) listener(job);
    if (job.batchId) {
      const batch = this.batches.get(job.batchId);
      if (batch) batch.updatedAt = job.updatedAt;
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      if (
        (job.state === 'succeeded' || job.state === 'failed') &&
        new Date(job.updatedAt).getTime() < cutoff
      ) {
        this.jobs.delete(id);
      }
    }
    for (const [id, batch] of this.batches) {
      const allTerminal = batch.jobIds.every((jobId) => {
        const job = this.jobs.get(jobId);
        return !job || job.state === 'succeeded' || job.state === 'failed';
      });
      if (allTerminal && new Date(batch.updatedAt).getTime() < cutoff) {
        this.batches.delete(id);
      }
    }
    if (this.jobs.size <= this.maxRecords) return;
    const candidates = [...this.jobs.values()]
      .filter((job) => job.state === 'succeeded' || job.state === 'failed')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const job of candidates) {
      if (this.jobs.size <= this.maxRecords) break;
      this.jobs.delete(job.id);
    }
  }

  private releaseImage(job: JobRecord): void {
    // Completed jobs retain hashes and metadata for cache/status inspection,
    // but not the uploaded bytes. This prevents the status store from
    // extending the lifetime of potentially large request bodies.
    job.image.bytes = Buffer.alloc(0);
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}
