import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';

import { loadConfig } from '../src/config.js';
import { MockLensAdapter } from '../src/adapters/mock-lens-adapter.js';
import { buildApp } from '../src/http/app.js';
import { representativePng } from '../test/image-fixture.js';

const imageBytes = representativePng(256, 192);

function multipart(size: number): { body: Buffer; contentType: string } {
  const boundary = `----offline-benchmark-${size}`;
  const chunks: Buffer[] = [];
  for (let index = 0; index < size; index += 1) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image-${index}.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      imageBytes,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function waitForBatch(app: ReturnType<typeof buildApp>, batchId: string): Promise<{ durationMs: number; status: string; succeeded: number; failed: number }> {
  const started = performance.now();
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    const response = await app.inject({ method: 'GET', url: `/v1/lens/batch/${batchId}` });
    const body = response.json<{ status: string; counts: { succeeded: number; failed: number } }>();
    if (body.status === 'completed' || body.status === 'failed' || body.status === 'cancelled') {
      return {
        durationMs: Number((performance.now() - started).toFixed(2)),
        status: body.status,
        succeeded: body.counts.succeeded,
        failed: body.counts.failed,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Benchmark batch ${batchId} did not complete.`);
}

const config = loadConfig({
  NODE_ENV: 'test',
  LENS_ADAPTER: 'mock',
  MAX_BATCH_SIZE: '100',
  MAX_QUEUE_SIZE: '500',
  WORKER_CONCURRENCY: '8',
  SEARCH_SYNC_WAIT_MS: '0',
  API_AUTH_REQUIRED: 'false',
});
const app = buildApp({ config, adapter: new MockLensAdapter({ delayMs: 2 }) });
const results: Array<Record<string, unknown>> = [];

try {
  for (const size of [1, 5, 10, 30, 50, 100]) {
    const before = process.memoryUsage();
    let peakRss = before.rss;
    let peakHeapUsed = before.heapUsed;
    let peakExternal = before.external;
    const sampleMemory = (): void => {
      const current = process.memoryUsage();
      peakRss = Math.max(peakRss, current.rss);
      peakHeapUsed = Math.max(peakHeapUsed, current.heapUsed);
      peakExternal = Math.max(peakExternal, current.external);
    };
    const sampler = setInterval(sampleMemory, 1);
    const upload = multipart(size);
    const started = performance.now();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/lens/batch?engine=google_lens&type=visual_matches',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    if (response.statusCode !== 202) throw new Error(`Batch ${size} returned HTTP ${response.statusCode}: ${response.body}`);
    const batchId = response.json<{ batch_id: string }>().batch_id;
    const terminal = await waitForBatch(app, batchId);
    clearInterval(sampler);
    sampleMemory();
    const after = process.memoryUsage();
    results.push({
      batchSize: size,
      admissionAndCompletionMs: Number((performance.now() - started).toFixed(2)),
      ...terminal,
      inputBytes: upload.body.byteLength,
      imageBytes: imageBytes.byteLength * size,
      rssBeforeBytes: before.rss,
      rssAfterBytes: after.rss,
      rssDeltaBytes: after.rss - before.rss,
      peakRssBytes: peakRss,
      heapUsedBeforeBytes: before.heapUsed,
      heapUsedAfterBytes: after.heapUsed,
      heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
      peakHeapUsedBytes: peakHeapUsed,
      externalBeforeBytes: before.external,
      externalAfterBytes: after.external,
      externalDeltaBytes: after.external - before.external,
      peakExternalBytes: peakExternal,
    });
  }
} finally {
  await app.close();
}

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    adapter: 'mock',
    delayMs: 2,
    workerConcurrency: 8,
    maxBatchBytes: config.maxBatchBytes,
    imageWidth: 256,
    imageHeight: 192,
    imageBytesEach: imageBytes.byteLength,
    liveGoogleQueries: false,
  },
  results,
  interpretation: 'Mock-only scalability evidence. It does not measure Google Lens latency, VPS CPU/RAM, or authorization.',
};
await writeFile('reports/offline-benchmark.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
