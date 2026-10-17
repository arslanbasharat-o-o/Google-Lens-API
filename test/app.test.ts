import { describe, expect, it, afterEach } from 'vitest';

import { loadConfig } from '../src/config.js';
import { MockLensAdapter } from '../src/adapters/mock-lens-adapter.js';
import { buildApp } from '../src/http/app.js';

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

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
    expect(openapi.json()).toMatchObject({ openapi: '3.0.3', paths: { '/search.json': expect.anything() } });
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
});
