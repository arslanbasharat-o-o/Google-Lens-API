import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';

import { loadConfig, type AppConfig } from '../config.js';
import { LensAutomationError, ServiceError, ValidationError } from '../domain/errors.js';
import {
  type ImagePayload,
  type JobRecord,
  type SearchOptions,
  type SerpApiResponse,
} from '../domain/types.js';
import { MockLensAdapter } from '../adapters/mock-lens-adapter.js';
import type { LensAdapter } from '../adapters/lens-adapter.js';
import { ScraplingRedisAdapter } from '../adapters/scrapling-redis-adapter.js';
import { DefaultLensParser } from '../parser/lens-parser.js';
import { InMemoryJobQueue } from '../queue/in-memory-queue.js';
import { RedisJobQueue } from '../queue/redis-queue.js';
import { ScraplingDispatchQueue } from '../queue/scrapling-dispatch-queue.js';
import type { JobQueue } from '../queue/types.js';
import { MemoryResultCache } from '../services/cache.js';
import { sha256 } from '../services/hash.js';
import { Metrics } from '../services/metrics.js';
import { RemoteImageFetcher } from '../services/remote-image.js';
import { SearchService } from '../services/search-service.js';
import { ImageStore, FileImageStore, type ImageStoreContract } from '../storage/image-store.js';
import { RedisJobPersistence } from '../storage/job-persistence.js';
import type { JobPersistence } from '../storage/job-persistence.js';
import { JobStore } from '../storage/job-store.js';
import { WorkerPool } from '../workers/worker-pool.js';
import { ApiKeyAuthenticator, idempotencyKey, IdempotencyStore, RateLimiter } from './security.js';
import { getOpenApiDocument } from './openapi.js';
import { normalizeUpload } from './uploads.js';

export interface AppOptions {
  config?: AppConfig;
  adapter?: LensAdapter;
  queue?: JobQueue;
  imageStore?: ImageStoreContract;
  persistence?: JobPersistence;
}

interface ParsedMultipart {
  files: ImagePayload[];
  fields: Record<string, string>;
  imageIds: string[];
  urls: string[];
}

interface StoredSubmission {
  kind: 'job' | 'batch' | 'image';
  id: string;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const adapter =
    options.adapter ??
    (config.adapter === 'scrapling'
      ? new ScraplingRedisAdapter(config.redisUrl!, {
            timeoutMs: config.scraplingResultTimeoutMs,
            pollIntervalMs: config.scraplingPollIntervalMs,
            heartbeatMaxAgeMs: config.scraplingHeartbeatMaxAgeMs,
          })
        : new MockLensAdapter());
  const queue = options.queue ?? createQueue(config);
  const imageStore = options.imageStore ?? createImageStore(config);
  const persistence = options.persistence ?? createPersistence(config);
  const store = new JobStore(config.maxJobRecords, config.jobRetentionMs, Date.now, persistence, imageStore);
  const metrics = new Metrics();
  const cache = new MemoryResultCache<SerpApiResponse>(config.cacheTtlMs, config.cacheMaxEntries);
  const workers = new WorkerPool(
    config.workerConcurrency,
    queue,
    store,
    adapter,
    new DefaultLensParser(),
    cache,
    metrics,
    config.maxAttempts,
    config.retryBaseMs,
    imageStore,
  );
  const service = new SearchService(store, workers, metrics, imageStore, cache);
  const remoteFetcher = new RemoteImageFetcher({
    timeoutMs: config.remoteFetchTimeoutMs,
    maxBytes: config.remoteFetchMaxBytes,
    maxRedirects: config.remoteFetchMaxRedirects,
    maxPixels: config.maxImagePixels,
    maxDimension: config.maxImageDimension,
  });
  const authenticator = new ApiKeyAuthenticator(config.apiKeys, config.authRequired, config.allowQueryApiKey);
  const rateLimiter = new RateLimiter(config.rateLimitPerMinute, config.rateLimitStoreMax);
  const idempotency = new IdempotencyStore<StoredSubmission>(config.jobRetentionMs);
  const app = Fastify({ logger: false });
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;

  app.register(multipart, {
    limits: {
      fileSize: config.maxImageBytes,
      files: config.maxBatchSize,
      fields: config.maxBatchSize * 2 + 16,
      parts: config.maxBatchSize * 2 + 16,
      fieldNameSize: 100,
      fieldSize: 2048,
    },
  });

  app.addHook('preHandler', async (request) => {
    const pathname = request.url.split('?', 1)[0];
    if (pathname === '/' || pathname === '/healthz' || pathname === '/health/live' || pathname === '/readyz' || pathname === '/health/ready' || pathname === '/openapi.json') {
      return;
    }
    const principal = authenticator.getPrincipal(request);
    rateLimiter.consume(principal ?? `ip:${request.ip}`);
  });

  app.addHook('onReady', async () => {
    await store.hydrate();
    await workers.start();
    cleanupTimer = setInterval(() => {
      imageStore.cleanup();
    }, Math.max(30_000, Math.floor(config.imageRetentionMs / 2)));
    for (const job of store.recoverableJobs()) {
      await workers.submit(job.id).catch((error) => store.fail(job.id, {
        code: 'recovery_enqueue_failed',
        message: error instanceof Error ? error.message : 'The recovered job could not be queued.',
        retryable: true,
      }));
    }
  });
  app.addHook('onClose', async () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
    await workers.stop();
    await store.flush();
    await persistence?.close();
    if ('close' in imageStore && typeof imageStore.close === 'function') await imageStore.close();
  });

  app.setErrorHandler((error, request, reply) => {
    const multipartError = error as Error & { code?: string; statusCode?: number };
    if (multipartError.code === 'FST_REQ_FILE_TOO_LARGE') {
      reply.code(413).send({ error: { code: 'image_too_large', message: 'The image exceeds the upload limit.' } });
      return;
    }
    if (error instanceof ServiceError) {
      if (error.statusCode === 401) reply.header('www-authenticate', 'Bearer');
      if (error.statusCode === 429) reply.header('retry-after', '60');
      reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }
    if (multipartError.statusCode && multipartError.statusCode < 500) {
      reply.code(multipartError.statusCode).send({
        error: { code: 'invalid_request', message: multipartError.message },
      });
      return;
    }
    request.log.error(error);
    reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error.' } });
  });

  app.get('/', async () => ({
    name: 'standalone-google-lens-api',
    version: '1.0.0',
    adapter: adapter.name,
    queue_backend: config.queueBackend,
    live_automation_enabled: adapter.live && config.liveAutomationEnabled,
    openapi: '/openapi.json',
  }));

  app.get('/openapi.json', async (_request, reply) => reply.send(getOpenApiDocument()));

  const healthHandler = async () => ({
    status: 'ok',
    service: 'standalone-google-lens-api',
    adapter: adapter.name,
    queue_backend: config.queueBackend,
    live_automation_enabled: adapter.live && config.liveAutomationEnabled,
    queue_depth: workers.queueDepth(),
    running_workers: workers.runningCount(),
    retained_images: imageStore.size(),
    uptime_seconds: Math.round(process.uptime()),
  });
  app.get('/healthz', healthHandler);
  app.get('/health/live', healthHandler);

  const readinessHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
    const authReady = !config.authRequired || config.apiKeys.length > 0;
    const liveReady = adapter.name === 'mock' || adapter.name === 'scrapling'
      ? config.scraplingWorkerMode !== 'live' || config.liveAutomationEnabled
      : config.liveAutomationEnabled;
    const workerReady = adapter.name !== 'scrapling'
      || await (adapter as ScraplingRedisAdapter).ready();
    const ready = authReady && liveReady && workerReady;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      adapter: adapter.name,
      queue_backend: config.queueBackend,
      live_automation_enabled: adapter.live && config.liveAutomationEnabled,
      auth_configured: config.apiKeys.length > 0,
      worker_ready: workerReady,
      reason: !authReady
        ? 'API_AUTH_REQUIRED is enabled but API_KEYS is empty.'
        : !liveReady
          ? 'A live worker mode is selected without both live authorization gates.'
          : !workerReady
            ? 'No healthy Scrapling worker heartbeat is available.'
          : undefined,
    });
  };
  app.get('/readyz', readinessHandler);
  app.get('/health/ready', readinessHandler);

  app.get('/metrics', async (_request, reply) =>
    reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(metrics.render(workers.queueDepth(), workers.runningCount(), cache.size())),
  );

  const imageHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = authenticator.getPrincipal(request);
    const multipartData = await readMultipart(request, config, 1);
    const image = multipartData.files[0]!;
    const fingerprint = `${image.sha256}:${image.mimeType}:${image.size}`;
    const key = idempotencyKey(request);
    if (key) {
      const previous = idempotency.get(scopedIdempotencyKey('image', key, principal), fingerprint);
      if (previous) {
        const existing = imageStore.getInfo(previous.id, principal);
        return reply.code(200).send({
          image_id: existing.imageId,
          sha256: existing.sha256,
          mime_type: existing.mimeType,
          size: existing.size,
          expires_at: existing.expiresAt,
        });
      }
    }
    const stored = imageStore.put(image, principal);
    if (key) idempotency.set(scopedIdempotencyKey('image', key, principal), fingerprint, { kind: 'image', id: stored.imageId });
    return reply.code(201).send({
      image_id: stored.imageId,
      sha256: stored.sha256,
      mime_type: stored.mimeType,
      size: stored.size,
      expires_at: stored.expiresAt,
    });
  };
  app.post('/image', imageHandler);
  // SerpApi-compatible clients often use /upload for the first step. Keep it
  // as a documented alias while /image remains the canonical endpoint.
  app.post('/upload', imageHandler);

  const searchHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = authenticator.getPrincipal(request);
    const multipartData = await readMultipart(request, config, 1);
    const options = parseSearchOptions(request, multipartData.fields);
    assertAdapterSearchOptions(adapter, options);
    const image = multipartData.files[0]!;
    const key = idempotencyKey(request);
    const fingerprint = submissionFingerprint([image], options);
    if (key) {
      const previous = idempotency.get(scopedIdempotencyKey('search', key, principal), fingerprint);
      if (previous) return sendSearchOutcome(store.requireVisibleJob(previous.id, principal), options, config.searchSyncWaitMs, store, reply);
    }
    const job = await service.submit(image, options, undefined, principal);
    if (key) idempotency.set(scopedIdempotencyKey('search', key, principal), fingerprint, { kind: 'job', id: job.id });
    return sendSearchOutcome(job, options, config.searchSyncWaitMs, store, reply);
  };
  app.post('/search', searchHandler);
  app.post('/search.json', searchHandler);
  app.post('/v1/search', searchHandler);
  app.post('/v1/lens/search', searchHandler);

  const getSearchHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = authenticator.getPrincipal(request);
    const query = request.query as Record<string, unknown>;
    const options = parseSearchOptions(request, {});
    assertAdapterSearchOptions(adapter, options);
    const imageId = readOptional(query.image_id ?? query.imageId);
    const url = readOptional(query.url);
    if (!imageId && !url) throw new ValidationError("Provide either 'image_id' or a public 'url'.");
    if (imageId && url) throw new ValidationError("Provide only one of 'image_id' or 'url'.");
    const image = imageId ? imageStore.get(imageId, principal) : await remoteFetcher.fetchImage(url!);
    const key = idempotencyKey(request);
    const fingerprint = submissionFingerprint([image], options);
    if (key) {
      const previous = idempotency.get(scopedIdempotencyKey('search', key, principal), fingerprint);
      if (previous) return sendSearchOutcome(store.requireVisibleJob(previous.id, principal), options, config.searchSyncWaitMs, store, reply);
    }
    const job = await service.submit(image, options, undefined, principal);
    if (key) idempotency.set(scopedIdempotencyKey('search', key, principal), fingerprint, { kind: 'job', id: job.id });
    return sendSearchOutcome(job, options, config.searchSyncWaitMs, store, reply);
  };
  app.get('/search', getSearchHandler);
  app.get('/search.json', getSearchHandler);

  const batchHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = authenticator.getPrincipal(request);
    const multipartData = await readMultipart(request, config, config.maxBatchSize, config.maxBatchBytes);
    const options = parseSearchOptions(request, multipartData.fields);
    assertAdapterSearchOptions(adapter, options);
    const totalImages = multipartData.files.length + multipartData.imageIds.length + multipartData.urls.length;
    if (totalImages === 0) throw new ValidationError('At least one image file, image_id, or url is required.');
    if (totalImages > config.maxBatchSize) {
      throw new ValidationError(`A maximum of ${config.maxBatchSize} images per batch is allowed.`);
    }
    if (queue.size() + totalImages > queue.capacity) {
      throw new ServiceError('queue_full', 'The search queue cannot admit this batch at its current capacity.', 429, true, {
        capacity: queue.capacity,
      });
    }
    const images: ImagePayload[] = [];
    let totalImageBytes = 0;
    const addBatchImage = (image: ImagePayload): void => {
      totalImageBytes += image.size;
      if (totalImageBytes > config.maxBatchBytes) {
        throw new ValidationError(`The batch exceeds the ${config.maxBatchBytes}-byte image limit.`, {
          max_batch_bytes: config.maxBatchBytes,
        });
      }
      images.push(image);
    };
    for (const image of multipartData.files) addBatchImage(image);
    for (const imageId of multipartData.imageIds) addBatchImage(imageStore.get(imageId, principal));
    for (const url of multipartData.urls) addBatchImage(await remoteFetcher.fetchImage(url));
    const key = idempotencyKey(request);
    const fingerprint = submissionFingerprint(images, options);
    if (key) {
      const previous = idempotency.get(scopedIdempotencyKey('batch', key, principal), fingerprint);
      if (previous) return reply.code(202).send(batchResponse(store.toPublicBatch(store.requireVisibleBatch(previous.id, principal))));
    }
    const batch = store.createBatch(principal);
    const jobs: JobRecord[] = [];
    try {
      for (const image of images) jobs.push(await service.submit(image, options, batch.id, principal));
    } catch (error) {
      for (const job of jobs) store.fail(job.id, {
        code: 'batch_admission_failed',
        message: 'The batch could not be fully admitted.',
        retryable: true,
      });
      await store.flush();
      throw error;
    }
    if (key) idempotency.set(scopedIdempotencyKey('batch', key, principal), fingerprint, { kind: 'batch', id: batch.id });
    return reply.code(202).send({
      ...batchResponse(store.toPublicBatch(batch)),
      jobs: jobs.map((job) => store.toPublicJob(job)),
    });
  };
  app.post('/v1/batches', batchHandler);
  app.post('/v1/lens/batch', batchHandler);

  const jobHandler = async (request: FastifyRequest) => {
    const principal = authenticator.getPrincipal(request);
    const { id } = request.params as { id: string };
    return store.toPublicJob(store.requireVisibleJob(id, principal));
  };
  app.get('/jobs/:id', jobHandler);
  app.get('/v1/jobs/:id', jobHandler);
  app.get('/v1/lens/jobs/:id', jobHandler);

  const cancelHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = authenticator.getPrincipal(request);
    const { id } = request.params as { id: string };
    const job = store.requireVisibleJob(id, principal);
    return reply.code(202).send(store.toPublicJob(store.cancel(job.id)));
  };
  app.delete('/v1/jobs/:id', cancelHandler);
  app.delete('/v1/lens/jobs/:id', cancelHandler);

  const batchStatusHandler = async (request: FastifyRequest) => {
    const principal = authenticator.getPrincipal(request);
    const { id } = request.params as { id: string };
    return store.toPublicBatch(store.requireVisibleBatch(id, principal));
  };
  app.get('/batches/:id', batchStatusHandler);
  app.get('/v1/batches/:id', batchStatusHandler);
  app.get('/v1/lens/batch/:id', batchStatusHandler);

  return app;
}

function createQueue(config: AppConfig): JobQueue {
  // Scrapling workers consume the Redis Streams contract directly. The API
  // process uses a bounded local dispatch queue to call the adapter, while
  // RedisJobPersistence and the worker result key make restart recovery safe.
  // Pointing a TypeScript consumer group at the same stream would race the
  // Python group and could strand requests.
  if (config.adapter === 'scrapling') return new ScraplingDispatchQueue(config.redisUrl!, config.maxQueueSize);
  if (config.queueBackend === 'redis') return new RedisJobQueue(config.redisUrl!, config.maxQueueSize);
  return new InMemoryJobQueue(config.maxQueueSize);
}

function createImageStore(config: AppConfig): ImageStoreContract {
  if (config.imageStorageBackend === 'file') {
    return new FileImageStore({
      directory: config.imageStorageDir,
      retentionMs: config.imageRetentionMs,
      maxRecords: config.maxImageRecords,
    });
  }
  return new ImageStore(config.imageRetentionMs, config.maxImageRecords);
}

function createPersistence(config: AppConfig): JobPersistence | undefined {
  if (!config.redisUrl || (config.queueBackend !== 'redis' && config.adapter !== 'scrapling')) return undefined;
  return new RedisJobPersistence(config.redisUrl);
}

function batchResponse(batch: ReturnType<JobStore['toPublicBatch']>) {
  return {
    batch_id: batch.id,
    status: batch.status,
    status_url: `/v1/lens/batch/${batch.id}`,
    counts: batch.counts,
  };
}

async function readMultipart(
  request: FastifyRequest,
  config: AppConfig,
  maxFiles: number,
  maxTotalBytes = Number.POSITIVE_INFINITY,
): Promise<ParsedMultipart> {
  if (!request.isMultipart()) {
    throw new ValidationError('Content-Type must be multipart/form-data with an image field.');
  }
  const files: ImagePayload[] = [];
  const fields: Record<string, string> = {};
  const imageIds: string[] = [];
  const urls: string[] = [];
  let totalBytes = 0;
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.fieldname !== 'image') {
        throw new ValidationError(`Unexpected file field '${part.fieldname}'. Use image.`);
      }
      if (files.length >= maxFiles) {
        throw new ValidationError(`A maximum of ${maxFiles} image file(s) is allowed.`);
      }
      const bytes = await part.toBuffer();
      totalBytes += bytes.length;
      if (totalBytes > maxTotalBytes) {
        throw new ValidationError(`The multipart request exceeds the ${maxTotalBytes}-byte batch limit.`, {
          max_batch_bytes: maxTotalBytes,
        });
      }
      if (part.file.truncated) {
        throw new ValidationError('The image upload exceeded the configured size limit.');
      }
      files.push(normalizeUpload(
        bytes,
        part.mimetype,
        part.filename,
        config.maxImageBytes,
        config.maxImagePixels,
        config.maxImageDimension,
      ));
    } else {
      const value = String(part.value).trim();
      if (part.fieldname === 'image_id' || part.fieldname === 'image_ids') {
        imageIds.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
      } else if (part.fieldname === 'url' || part.fieldname === 'urls') {
        urls.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
      } else {
        fields[part.fieldname] = fields[part.fieldname]
          ? `${fields[part.fieldname]},${value}`
          : value;
      }
    }
  }
  return { files, fields, imageIds, urls };
}

function parseSearchOptions(request: FastifyRequest, fields: Record<string, string>): SearchOptions {
  const query = request.query as Record<string, unknown>;
  const value = (name: string): unknown => query[name] ?? fields[name];
  const engine = String(value('engine') ?? 'google_lens');
  if (engine !== 'google_lens') throw new ValidationError("Only engine='google_lens' is supported.");

  const type = readOptional(value('type')) ?? 'all';
  if (!['all', 'exact_matches', 'visual_matches'].includes(type)) {
    throw new ValidationError("type must be one of 'all', 'exact_matches', or 'visual_matches'.");
  }
  const safe = readOptional(value('safe'));
  if (safe && safe !== 'active' && safe !== 'off') throw new ValidationError("safe must be 'active' or 'off'.");
  return {
    engine: 'google_lens',
    type: type as SearchOptions['type'],
    ...(readOptional(value('q')) ? { q: readOptional(value('q')) } : {}),
    ...(readOptional(value('hl')) ? { hl: readOptional(value('hl')) } : {}),
    ...(readOptional(value('country')) ? { country: readOptional(value('country')) } : {}),
    ...(safe ? { safe: safe as SearchOptions['safe'] } : {}),
    ...(readBooleanOption(value('auto_crop')) !== undefined
      ? { autoCrop: readBooleanOption(value('auto_crop')) }
      : {}),
    ...(readBooleanOption(value('no_cache')) !== undefined
      ? { noCache: readBooleanOption(value('no_cache')) }
      : {}),
    ...(readBooleanOption(value('async')) !== undefined
      ? { async: readBooleanOption(value('async')) }
      : {}),
  };
}

function assertAdapterSearchOptions(adapter: LensAdapter, options: SearchOptions): void {
  if (adapter.name !== 'scrapling') return;
  const unsupported = [
    options.q !== undefined ? 'q' : undefined,
    options.hl !== undefined ? 'hl' : undefined,
    options.country !== undefined ? 'country' : undefined,
    options.safe !== undefined ? 'safe' : undefined,
    options.autoCrop !== undefined ? 'auto_crop' : undefined,
  ].filter((name): name is string => name !== undefined);
  if (unsupported.length === 0) return;
  throw new ValidationError(
    `The live Scrapling adapter does not apply these search options: ${unsupported.join(', ')}. Omit them or use the mock adapter.`,
    { adapter: adapter.name, unsupported_options: unsupported },
  );
}

function readOptional(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 200) : undefined;
}

function readBooleanOption(value: unknown): boolean | undefined {
  const normalized = readOptional(value);
  if (normalized === undefined) return undefined;
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new ValidationError('Boolean search options must be true, false, 1, or 0.');
}

function submissionFingerprint(images: ImagePayload[], options: SearchOptions): string {
  return sha256(Buffer.from(JSON.stringify({
    images: images.map((image) => image.sha256),
    options: { ...options, async: undefined, noCache: undefined },
  })));
}

function scopedIdempotencyKey(kind: string, key: string, principal?: string): string {
  return `${principal ?? 'public'}:${kind}:${key}`;
}

async function sendSearchOutcome(
  job: JobRecord,
  options: SearchOptions,
  waitMs: number,
  store: JobStore,
  reply: FastifyReply,
): Promise<unknown> {
  const terminal = options.async ? undefined : await store.waitForTerminal(job.id, waitMs);
  if (!terminal) {
    return reply.code(202).send({
      job_id: job.id,
      status: job.state,
      status_url: `/v1/jobs/${job.id}`,
    });
  }
  if (terminal.state === 'succeeded' && terminal.result) return reply.code(200).send(terminal.result);
  if (terminal.state === 'cancelled') {
    return reply.code(409).send({
      error: { code: 'cancelled', message: 'The search job was cancelled.', retryable: false },
      job: store.toPublicJob(terminal),
    });
  }
  const error = terminal.error ?? {
    code: 'worker_error',
    message: 'The search worker failed without an error payload.',
    retryable: true,
  };
  const status = error.code === 'queue_full' ? 429 : 502;
  return reply.code(status).send({ error, job: store.toPublicJob(terminal) });
}
