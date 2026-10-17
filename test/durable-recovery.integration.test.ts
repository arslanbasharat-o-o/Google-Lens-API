import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';

import { FileImageStore } from '../src/storage/image-store.js';
import { RedisJobPersistence } from '../src/storage/job-persistence.js';
import { JobStore } from '../src/storage/job-store.js';
import type { ImagePayload, SearchOptions } from '../src/domain/types.js';

const redisUrl = process.env.REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;
const options: SearchOptions = { engine: 'google_lens', type: 'all' };

function payload(index: number): ImagePayload {
  const bytes = Buffer.from(`representative-recovery-image-${index}`);
  return {
    bytes,
    mimeType: 'image/png',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

describeRedis('real Redis recovery contract', () => {
  it('hydrates and completes a 30-image batch after interruption', async () => {
    const prefix = `integration:${randomUUID()}:`;
    const directory = mkdtempSync(join(tmpdir(), 'lens-recovery-'));
    const imageStore = new FileImageStore({ directory, retentionMs: 60_000, maxRecords: 50 });
    const firstPersistence = new RedisJobPersistence(redisUrl!, { keyPrefix: prefix });
    const firstStore = new JobStore(100, 60_000, Date.now, firstPersistence, imageStore);
    const batch = firstStore.createBatch('integration-principal');

    for (let index = 0; index < 15; index += 1) {
      const image = payload(index);
      const stored = imageStore.put(image, 'integration-principal');
      const job = firstStore.createJob(image, options, batch.id, stored.imageId, 'integration-principal');
      firstStore.setCacheKey(job.id, `integration:${index}`);
      await firstStore.flush();
    }
    await firstPersistence.close();

    const recoveredPersistence = new RedisJobPersistence(redisUrl!, { keyPrefix: prefix });
    const recovered = new JobStore(100, 60_000, Date.now, recoveredPersistence, imageStore);
    await recovered.hydrate();
    expect(recovered.getBatch(batch.id)?.jobIds).toHaveLength(15);
    expect(recovered.recoverableJobs()).toHaveLength(15);

    for (let index = 15; index < 30; index += 1) {
      const image = payload(index);
      const stored = imageStore.put(image, 'integration-principal');
      const job = recovered.createJob(image, options, batch.id, stored.imageId, 'integration-principal');
      recovered.setCacheKey(job.id, `integration:${index}`);
      await recovered.flush();
    }

    const snapshot = await recoveredPersistence.hydrate();
    expect(snapshot.jobs).toHaveLength(30);
    expect(snapshot.batches.find((candidate) => candidate.id === batch.id)?.jobIds).toHaveLength(30);
    await recoveredPersistence.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
