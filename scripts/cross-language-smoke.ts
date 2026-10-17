import { randomUUID } from 'node:crypto';

import { ScraplingRedisAdapter } from '../src/adapters/scrapling-redis-adapter.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380/0';
const imageId = process.env.IMAGE_ID;
const jobId = `cross-language-${randomUUID()}`;

if (!imageId) {
  throw new Error('IMAGE_ID must name an image mounted in the Python worker IMAGE_STORAGE_DIR.');
}

const adapter = new ScraplingRedisAdapter(redisUrl, {
  timeoutMs: Number(process.env.SCRAPLING_RESULT_TIMEOUT_MS ?? 10_000),
  pollIntervalMs: 25,
});

try {
  const snapshot = await adapter.search({
    image: Buffer.from('not-published'),
    mimeType: 'image/png',
    imageId,
    jobId,
    options: { engine: 'google_lens', type: 'all' },
    attempt: 1,
  });
  if (snapshot.links.length === 0 && (snapshot.exactMatches?.length ?? 0) === 0) {
    throw new Error('Cross-language worker returned no parsed result links.');
  }
  process.stdout.write(JSON.stringify({ jobId, links: snapshot.links.length, url: snapshot.links[0]?.href }) + '\n');
} finally {
  await adapter.close();
}
