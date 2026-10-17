import { describe, expect, it, afterEach } from 'vitest';

import { loadConfig } from '../src/config.js';
import { MockLensAdapter } from '../src/adapters/mock-lens-adapter.js';
import { buildApp } from '../src/http/app.js';
import { representativePng } from './image-fixture.js';

const pngBytes = representativePng(256, 192);

function multipart(
  files: Array<{ name: string; bytes: Buffer; mime: string; filename?: string }>,
  fields: Record<string, string> = {},
): { body: Buffer; contentType: string } {
  const boundary = '----offline-lens-test-boundary';
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename ?? 'image.png'}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      ),
      file.bytes,
      Buffer.from('\r\n'),
    );
  }
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    LENS_ADAPTER: 'mock',
    GOOGLE_LENS_LIVE_ENABLED: 'false',
    GOOGLE_LENS_LIVE_AUTHORIZED: 'false',
    SEARCH_SYNC_WAIT_MS: '1000',
    ...overrides,
  });
}

async function waitForJob(app: ReturnType<typeof buildApp>, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/v1/jobs/${id}` });
    const body = response.json<Record<string, unknown>>();
    if (body.status === 'succeeded' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('job did not finish during test');
}

describe('HTTP API', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('serves health, readiness, metrics, and OpenAPI metadata', async () => {
    const app = buildApp({ config: testConfig() });
    apps.push(app);
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', adapter: 'mock' });

    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toContain('lens_queue_depth');
    const openapi = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(openapi.statusCode).toBe(200);
    const document = openapi.json<{
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
    }>();
    expect(document).toMatchObject({ openapi: '3.0.3' });
    expect(document.paths).toEqual(expect.objectContaining({
      '/upload': expect.anything(),
      '/search': expect.anything(),
      '/search.json': expect.anything(),
      '/v1/search': expect.anything(),
      '/v1/lens/search': expect.anything(),
      '/v1/jobs/{id}': expect.anything(),
      '/jobs/{id}': expect.anything(),
    }));
    expect(document.components.schemas.SearchResponse.required).toEqual(
      expect.arrayContaining(['search_metadata', 'search_parameters', 'visual_matches']),
    );
    expect(document.components.schemas.VisualMatch.required).toEqual(
      expect.arrayContaining(['position', 'title', 'link', 'source']),
    );
    const getParameters = document.paths['/search.json']?.get as { parameters: Array<{ name: string }> };
    expect(getParameters.parameters.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(['q', 'hl', 'country', 'safe', 'auto_crop', 'no_cache', 'async']),
    );
  });

  it('accepts a safe upload, normalizes results, and serves a hash-keyed cache hit', async () => {
    const adapter = new MockLensAdapter();
    const app = buildApp({ config: testConfig(), adapter });
    apps.push(app);
    const upload = multipart([{ name: 'image', bytes: pngBytes, mime: 'image/png' }], { hl: 'en' });

    const first = await app.inject({
      method: 'POST',
      url: '/search.json?engine=google_lens',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(first.statusCode).toBe(200);
    const firstJob = first.json<{ search_metadata: { id: string; cached: boolean } }>();
    const firstBody = first.json<{
      search_parameters: { engine: string; hl?: string };
      visual_matches: Array<{ position: number; source: string }>;
    }>();
    expect(firstBody.search_parameters).toMatchObject({ engine: 'google_lens', hl: 'en' });
    expect(firstBody.visual_matches[0]).toMatchObject({ position: 1, source: 'example.com' });
    expect(firstJob.search_metadata.cached).toBe(false);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{ search_metadata: { id: string; cached: boolean } }>();
    expect(secondBody.search_metadata.cached).toBe(true);
    expect(secondBody.search_metadata.id).not.toBe(firstJob.search_metadata.id);
    expect(adapter.calls).toBe(1);

    const status = await app.inject({ method: 'GET', url: `/v1/jobs/${firstJob.search_metadata.id}` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ status: 'succeeded', result: { visual_matches: expect.any(Array) } });
  });

  it('rejects content-type spoofing before queueing', async () => {
    const adapter = new MockLensAdapter();
    const app = buildApp({ config: testConfig(), adapter });
    apps.push(app);
    const upload = multipart([{ name: 'image', bytes: pngBytes, mime: 'image/jpeg' }]);
    const response = await app.inject({
      method: 'POST',
      url: '/search.json',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
    expect(adapter.calls).toBe(0);
  });

  it('returns typed challenge failures and exposes failed job status', async () => {
    const app = buildApp({ config: testConfig(), adapter: new MockLensAdapter({ scenario: 'challenge' }) });
    apps.push(app);
    const upload = multipart([{ name: 'image', bytes: pngBytes, mime: 'image/png' }]);
    const response = await app.inject({
      method: 'POST',
      url: '/search.json',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(response.statusCode).toBe(502);
    const body = response.json<{ error: { code: string }; job: { id: string; status: string } }>();
    expect(body.error.code).toBe('lens_challenge');
    expect(body.job.status).toBe('failed');
  });

  it('accepts a bounded batch and reports child job states', async () => {
    const app = buildApp({ config: testConfig(), adapter: new MockLensAdapter() });
    apps.push(app);
    const upload = multipart([
      { name: 'image', bytes: pngBytes, mime: 'image/png', filename: 'one.png' },
      { name: 'image', bytes: pngBytes, mime: 'image/png', filename: 'two.png' },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/batches',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(response.statusCode).toBe(202);
    const batchId = response.json<{ batch_id: string }>().batch_id;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await app.inject({ method: 'GET', url: `/v1/batches/${batchId}` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      id: batchId,
      status: 'completed',
      counts: { succeeded: 2 },
      jobs: expect.any(Array),
    });
  });

  it('supports image upload, image-id GET search, and the Lens route aliases', async () => {
    const app = buildApp({ config: testConfig(), adapter: new MockLensAdapter() });
    apps.push(app);
    const upload = multipart([{ name: 'image', bytes: pngBytes, mime: 'image/png' }]);
    const imageResponse = await app.inject({
      method: 'POST',
      url: '/image',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(imageResponse.statusCode).toBe(201);
    const imageId = imageResponse.json<{ image_id: string }>().image_id;

    const byId = await app.inject({
      method: 'GET',
      url: `/search.json?engine=google_lens&image_id=${imageId}&type=visual_matches`,
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json()).toMatchObject({ search_parameters: { type: 'visual_matches' } });

    const direct = await app.inject({
      method: 'POST',
      url: '/v1/lens/search?async=true',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(direct.statusCode).toBe(202);
    expect(direct.json()).toMatchObject({ status_url: expect.stringContaining('/v1/jobs/') });
  });

  it('keeps the RMA upload alias and visual match field names compatible', async () => {
    const app = buildApp({ config: testConfig(), adapter: new MockLensAdapter() });
    apps.push(app);
    const upload = multipart([{ name: 'image', bytes: pngBytes, mime: 'image/png', filename: 'chair.png' }]);
    const uploaded = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(uploaded.statusCode).toBe(201);
    const imageId = uploaded.json<{ image_id: string }>().image_id;

    const result = await app.inject({
      method: 'GET',
      url: `/search?engine=google_lens&image_id=${imageId}&type=visual_matches`,
    });
    expect(result.statusCode).toBe(200);
    const resultBody = result.json<{
      search_metadata: { status: string };
      search_parameters: { engine: string; type: string };
      visual_matches: Array<Record<string, unknown>>;
    }>();
    expect(resultBody).toMatchObject({
      search_metadata: { status: 'Success' },
      search_parameters: { engine: 'google_lens', type: 'visual_matches' },
    });
    expect(resultBody.visual_matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        position: 1,
        title: expect.any(String),
        link: expect.stringMatching(/^https?:\/\//),
        source: expect.any(String),
      }),
    ]));
  });

  it('rejects live-only unsupported options before publishing a Scrapling job', async () => {
    const calls: Array<unknown> = [];
    const liveAdapter = {
      name: 'scrapling' as const,
      live: true,
      search: async (input: unknown) => {
        calls.push(input);
        throw new Error('must not be called');
      },
    };
    const app = buildApp({ config: testConfig(), adapter: liveAdapter });
    apps.push(app);
    const upload = multipart([{ name: 'image', bytes: pngBytes, mime: 'image/png' }]);
    const response = await app.inject({
      method: 'POST',
      url: '/search.json?hl=en&safe=active&auto_crop=true',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'validation_error',
        details: { unsupported_options: ['hl', 'safe', 'auto_crop'] },
      },
    });
    expect(calls).toHaveLength(0);
  });

  it('bounds aggregate batch image bytes before admission', async () => {
    const adapter = new MockLensAdapter();
    const app = buildApp({
      config: testConfig({ MAX_BATCH_BYTES: '1000' }),
      adapter,
    });
    apps.push(app);
    const upload = multipart([
      { name: 'image', bytes: representativePng(128, 96), mime: 'image/png' },
      { name: 'image', bytes: representativePng(128, 96), mime: 'image/png' },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/lens/batch',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_error', details: { max_batch_bytes: 1000 } } });
    expect(adapter.calls).toBe(0);
  });

  it('accepts a 30-image batch without mixing child job IDs', async () => {
    const app = buildApp({
      config: testConfig({ MAX_BATCH_SIZE: '30', WORKER_CONCURRENCY: '4', SEARCH_SYNC_WAIT_MS: '0' }),
      adapter: new MockLensAdapter({ delayMs: 1 }),
    });
    apps.push(app);
    const upload = multipart(Array.from({ length: 30 }, (_, index) => ({
      name: 'image',
      bytes: representativePng(256 + index, 192),
      mime: 'image/png',
      filename: `image-${index}.png`,
    })));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/lens/batch',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<{ batch_id: string; jobs: Array<{ id: string }> }>();
    expect(body.jobs).toHaveLength(30);
    expect(new Set(body.jobs.map((job) => job.id)).size).toBe(30);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await app.inject({ method: 'GET', url: `/v1/lens/batch/${body.batch_id}` });
      if (status.json<{ status: string }>().status === 'completed') {
        expect(status.json<{ counts: { succeeded: number } }>().counts.succeeded).toBe(30);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('30-image batch did not complete');
  });

  it('requires API keys when production authentication is enabled', async () => {
    const app = buildApp({
      config: testConfig({ NODE_ENV: 'production', LENS_ADAPTER: 'mock', ALLOW_MOCK_ADAPTER_IN_PRODUCTION: 'true', API_AUTH_REQUIRED: 'true', API_KEYS: 'test-key' }),
      adapter: new MockLensAdapter(),
    });
    apps.push(app);
    const upload = multipart([{ name: 'image', bytes: pngBytes, mime: 'image/png' }]);
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/search.json',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(unauthorized.statusCode).toBe(401);
    const authorized = await app.inject({
      method: 'POST',
      url: '/search.json',
      headers: { 'content-type': upload.contentType, authorization: 'Bearer test-key' },
      payload: upload.body,
    });
    expect(authorized.statusCode).toBe(200);
  });

  it('returns 202 while a slow worker is still running', async () => {
    const app = buildApp({
      config: testConfig({ SEARCH_SYNC_WAIT_MS: '0' }),
      adapter: new MockLensAdapter({ delayMs: 30 }),
    });
    apps.push(app);
    const upload = multipart([{ name: 'image', bytes: pngBytes, mime: 'image/png' }]);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(response.statusCode).toBe(202);
    const jobId = response.json<{ job_id: string }>().job_id;
    expect((await waitForJob(app, jobId)).status).toBe('succeeded');
  });

  it('coalesces concurrent cache-key-equivalent work before a second adapter call', async () => {
    const adapter = new MockLensAdapter({ delayMs: 30 });
    const app = buildApp({
      config: testConfig({ SEARCH_SYNC_WAIT_MS: '0', WORKER_CONCURRENCY: '2' }),
      adapter,
    });
    apps.push(app);
    const upload = multipart([{ name: 'image', bytes: pngBytes, mime: 'image/png' }]);
    const first = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(first.statusCode).toBe(202);
    for (let attempt = 0; attempt < 20 && adapter.calls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const second = await app.inject({
      method: 'POST',
      url: '/v1/search',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(second.statusCode).toBe(202);
    const firstJob = first.json<{ job_id: string }>().job_id;
    const secondJob = second.json<{ job_id: string }>().job_id;
    expect(firstJob).not.toBe(secondJob);
    expect((await waitForJob(app, firstJob)).status).toBe('succeeded');
    expect((await waitForJob(app, secondJob)).status).toBe('succeeded');
    expect(adapter.calls).toBe(1);
  });

  it('scopes image resources to the authenticated API principal and rejects URL API keys by default', async () => {
    const app = buildApp({
      config: testConfig({ NODE_ENV: 'production', LENS_ADAPTER: 'mock', ALLOW_MOCK_ADAPTER_IN_PRODUCTION: 'true', API_AUTH_REQUIRED: 'true', API_KEYS: 'key-one,key-two' }),
      adapter: new MockLensAdapter(),
    });
    apps.push(app);
    const upload = multipart([{ name: 'image', bytes: pngBytes, mime: 'image/png' }]);
    const created = await app.inject({
      method: 'POST',
      url: '/image',
      headers: { 'content-type': upload.contentType, authorization: 'Bearer key-one' },
      payload: upload.body,
    });
    expect(created.statusCode).toBe(201);
    const imageId = created.json<{ image_id: string }>().image_id;
    const crossPrincipal = await app.inject({
      method: 'GET',
      url: `/search.json?engine=google_lens&image_id=${imageId}`,
      headers: { authorization: 'Bearer key-two' },
    });
    expect(crossPrincipal.statusCode).toBe(404);

    const queryKey = await app.inject({
      method: 'GET',
      url: `/search.json?engine=google_lens&image_id=${imageId}&api_key=key-one`,
    });
    expect(queryKey.statusCode).toBe(401);
  });
});
