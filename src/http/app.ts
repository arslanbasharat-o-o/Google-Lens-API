import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';

import { loadConfig, type AppConfig } from '../config.js';
import { LensAutomationError, ServiceError, ValidationError } from '../domain/errors.js';
import {
  type ImagePayload,
  type SearchOptions,
  type JobRecord,
  type SerpApiResponse,
} from '../domain/types.js';
import { MockLensAdapter } from '../adapters/mock-lens-adapter.js';
import type { LensAdapter } from '../adapters/lens-adapter.js';
import { PlaywrightLensAdapter } from '../adapters/playwright-lens-adapter.js';
import { DefaultLensParser } from '../parser/lens-parser.js';
import { InMemoryJobQueue } from '../queue/in-memory-queue.js';
import type { JobQueue } from '../queue/types.js';
import { MemoryResultCache } from '../services/cache.js';
import { Metrics } from '../services/metrics.js';
import { SearchService } from '../services/search-service.js';
import { JobStore } from '../storage/job-store.js';
import { WorkerPool } from '../workers/worker-pool.js';
import { getOpenApiDocument } from './openapi.js';
import { normalizeUpload } from './uploads.js';

export interface AppOptions {
  config?: AppConfig;
  adapter?: LensAdapter;
  queue?: JobQueue;
}

interface ParsedMultipart {
  files: ImagePayload[];
  fields: Record<string, string>;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const adapter =
    options.adapter ??
    (config.adapter === 'playwright'
      ? new PlaywrightLensAdapter(config)
      : new MockLensAdapter());
  const queue = options.queue ?? new InMemoryJobQueue(config.maxQueueSize);
  const store = new JobStore(config.maxJobRecords, config.jobRetentionMs);
  const metrics = new Metrics();
  const cache = new MemoryResultCache<SerpApiResponse>(
    config.cacheTtlMs,
    config.cacheMaxEntries,
  );
  const workers = new WorkerPool(
    config.workerConcurrency,
    queue,
    store,
    adapter,
    new DefaultLensParser(),
    cache,
    metrics,
  );
  const service = new SearchService(store, workers, metrics);
  const app = Fastify({ logger: false });

  app.register(multipart, {
    limits: {
      fileSize: config.maxImageBytes,
      files: config.maxBatchSize,
      fields: 12,
      parts: config.maxBatchSize + 12,
      fieldNameSize: 100,
      fieldSize: 2048,
    },
  });

  app.addHook('onReady', async () => workers.start());
  app.addHook('onClose', async () => workers.stop());

  app.setErrorHandler((error, request, reply) => {
    const multipartError = error as Error & { code?: string; statusCode?: number };
    if (multipartError.code === 'FST_REQ_FILE_TOO_LARGE') {
      reply.code(413).send({ error: { code: 'image_too_large', message: 'The image exceeds the upload limit.' } });
      return;
    }
    if (error instanceof ServiceError) {
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
    live_automation_enabled: adapter.live && config.liveAutomationEnabled,
    openapi: '/openapi.json',
  }));

  app.get('/openapi.json', async (_request, reply) => reply.send(getOpenApiDocument()));

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'standalone-google-lens-api',
    adapter: adapter.name,
    live_automation_enabled: adapter.live && config.liveAutomationEnabled,
    queue_depth: workers.queueDepth(),
    running_workers: workers.runningCount(),
    uptime_seconds: Math.round(process.uptime()),
  }));

  app.get('/readyz', async (_request, reply) => {
    const ready = adapter.name === 'mock' || config.liveAutomationEnabled;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      adapter: adapter.name,
      live_automation_enabled: adapter.live && config.liveAutomationEnabled,
      reason: ready ? undefined : 'Playwright adapter is selected without both live authorization gates.',
    });
  });

  app.get('/metrics', async (_request, reply) =>
    reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(metrics.render(workers.queueDepth(), workers.runningCount(), cache.size())),
  );

  const searchHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const multipartData = await readMultipart(request, config, 1);
    const options = parseSearchOptions(request, multipartData.fields);
    const job = await service.submit(multipartData.files[0]!, options);
    return sendSearchOutcome(job, config.searchSyncWaitMs, store, reply);
  };
  app.post('/search', searchHandler);
  app.post('/search.json', searchHandler);
  app.post('/v1/search', searchHandler);

  const batchHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const multipartData = await readMultipart(request, config, config.maxBatchSize);
    const options = parseSearchOptions(request, multipartData.fields);
    const batch = store.createBatch();
    const jobs: JobRecord[] = [];
    for (const image of multipartData.files) {
      jobs.push(await service.submit(image, options, batch.id));
    }
    return reply.code(202).send({
      batch_id: batch.id,
      status: 'queued',
      status_url: `/v1/batches/${batch.id}`,
      jobs: jobs.map((job) => store.toPublicJob(job)),
    });
  };
  app.post('/v1/batches', batchHandler);

  const jobHandler = async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    return store.toPublicJob(store.requireJob(id));
  };
  app.get('/jobs/:id', jobHandler);
  app.get('/v1/jobs/:id', jobHandler);

  const batchStatusHandler = async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const batch = store.getBatch(id);
    if (!batch) throw new ServiceError('not_found', `Batch '${id}' was not found.`, 404);
    return store.toPublicBatch(batch);
  };
  app.get('/batches/:id', batchStatusHandler);
  app.get('/v1/batches/:id', batchStatusHandler);

  return app;
}

async function readMultipart(
  request: FastifyRequest,
  config: AppConfig,
  maxFiles: number,
): Promise<ParsedMultipart> {
  if (!request.isMultipart()) {
    throw new ValidationError('Content-Type must be multipart/form-data with an image field.');
  }
  const files: ImagePayload[] = [];
  const fields: Record<string, string> = {};
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.fieldname !== 'image') {
        throw new ValidationError(`Unexpected file field '${part.fieldname}'. Use image.`);
      }
      if (files.length >= maxFiles) {
        throw new ValidationError(`A maximum of ${maxFiles} image file(s) is allowed.`);
      }
      const bytes = await part.toBuffer();
      if (part.file.truncated) {
        throw new ValidationError('The image upload exceeded the configured size limit.');
      }
      files.push(normalizeUpload(bytes, part.mimetype, part.filename, config.maxImageBytes));
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  if (files.length === 0) throw new ValidationError('At least one image file is required.');
  return { files, fields };
}

function parseSearchOptions(request: FastifyRequest, fields: Record<string, string>): SearchOptions {
  const query = request.query as Record<string, unknown>;
  const engine = String(query.engine ?? fields.engine ?? 'google_lens');
  if (engine !== 'google_lens') throw new ValidationError("Only engine='google_lens' is supported.");
  return {
    engine: 'google_lens',
    ...(readOptional(query.q ?? fields.q) ? { q: readOptional(query.q ?? fields.q) } : {}),
    ...(readOptional(query.hl ?? fields.hl) ? { hl: readOptional(query.hl ?? fields.hl) } : {}),
    ...(readOptional(query.country ?? fields.country)
      ? { country: readOptional(query.country ?? fields.country) }
      : {}),
    ...(readOptional(query.type ?? fields.type) ? { type: readOptional(query.type ?? fields.type) } : {}),
  };
}

function readOptional(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 100) : undefined;
}

async function sendSearchOutcome(
  job: JobRecord,
  waitMs: number,
  store: JobStore,
  reply: FastifyReply,
): Promise<unknown> {
  const terminal = await store.waitForTerminal(job.id, waitMs);
  if (!terminal) {
    return reply.code(202).send({
      job_id: job.id,
      status: job.state,
      status_url: `/v1/jobs/${job.id}`,
    });
  }
  if (terminal.state === 'succeeded' && terminal.result) return reply.code(200).send(terminal.result);
  const error = terminal.error ?? {
    code: 'worker_error',
    message: 'The search worker failed without an error payload.',
    retryable: true,
  };
  const status = error.code === 'queue_full' ? 429 : 502;
  return reply.code(status).send({ error, job: store.toPublicJob(terminal) });
}
