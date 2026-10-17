import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { ScraplingRedisAdapter } from '../src/adapters/scrapling-redis-adapter.js';
import type { RedisClientLike } from '../src/storage/redis-client.js';
import { FileImageStore } from '../src/storage/image-store.js';
import { RedisJobPersistence } from '../src/storage/job-persistence.js';
import { RedisStreamsJobQueue } from '../src/queue/redis-streams-queue.js';
import { JobStore } from '../src/storage/job-store.js';
import type { JobRecord } from '../src/domain/types.js';

class FakeRedis implements RedisClientLike {
  public readonly values = new Map<string, string>();
  public readonly sets = new Map<string, Set<string>>();
  public readonly xaddCalls: Array<{ stream: string; fields: string[] }> = [];
  public readonly xackCalls: string[] = [];
  public readonly messages: Array<[string, string[]]> = [];
  public groupCalls = 0;
  public autoResult?: (jobId: string) => string;

  public async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  public async set(key: string, value: string): Promise<'OK'> {
    this.values.set(key, value);
    return 'OK';
  }

  public async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) if (this.values.delete(key)) count += 1;
    return count;
  }

  public async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const before = set.size;
    for (const member of members) set.add(member);
    this.sets.set(key, set);
    return set.size - before;
  }

  public async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    let count = 0;
    for (const member of members) if (set.delete(member)) count += 1;
    return count;
  }

  public async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  public async xadd(stream: string, _id: string, ...fields: string[]): Promise<string> {
    this.xaddCalls.push({ stream, fields });
    const values = new Map<string, string>();
    for (let index = 0; index + 1 < fields.length; index += 2) values.set(fields[index]!, fields[index + 1]!);
    if (this.autoResult && values.get('job_id')) {
      this.values.set(`lens:result:v1:${values.get('job_id')!}`, this.autoResult(values.get('job_id')!));
    }
    return `${this.xaddCalls.length}-0`;
  }

  public async xgroup(): Promise<'OK'> {
    this.groupCalls += 1;
    return 'OK';
  }

  public async xreadgroup(): Promise<unknown> {
    if (this.messages.length === 0) return null;
    return [['lens:jobs:v1', [this.messages.shift()!]]];
  }

  public async xack(_stream: string, _group: string, ...ids: string[]): Promise<number> {
    this.xackCalls.push(...ids);
    return ids.length;
  }

  public async xlen(): Promise<number> {
    return this.messages.length;
  }
}

const options = { engine: 'google_lens' as const, type: 'all' as const };

function payload(bytes = Buffer.from('durable-image')) {
  return {
    bytes,
    mimeType: 'image/png' as const,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

function job(id: string, state: JobRecord['state'] = 'queued'): JobRecord {
  const now = new Date(0).toISOString();
  return {
    id,
    cacheKey: 'cache-key',
    imageId: '11111111-1111-4111-8111-111111111111',
    image: { ...payload(), bytes: Buffer.alloc(0) },
    options,
    state,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe('durable TypeScript backend contract', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('writes FileImageStore bytes and metadata atomically under the configured root', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lens-image-store-'));
    tempDirs.push(directory);
    const store = new FileImageStore({ directory, retentionMs: 60_000, maxRecords: 2 });
    const info = store.put(payload());

    expect(readFileSync(join(directory, info.imageId))).toEqual(Buffer.from('durable-image'));
    expect(JSON.parse(readFileSync(join(directory, `${info.imageId}.json`), 'utf8'))).toMatchObject({
      imageId: info.imageId,
      sha256: info.sha256,
    });
    expect(store.get(info.imageId).bytes).toEqual(Buffer.from('durable-image'));
    store.delete('../outside');
    expect(statSync(join(directory, info.imageId)).isFile()).toBe(true);
    store.delete(info.imageId);
    expect(store.size()).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('cleans expired metadata and image bytes during retention maintenance', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lens-image-retention-'));
    tempDirs.push(directory);
    let now = 1_000;
    const store = new FileImageStore({ directory, retentionMs: 10, maxRecords: 2, now: () => now });
    const info = store.put(payload(Buffer.from('expires')));
    now = 1_011;
    expect(store.cleanup()).toBe(1);
    expect(store.size()).toBe(0);
    expect(() => readFileSync(join(directory, info.imageId))).toThrow();
  });

  it('publishes only the v1 job reference and maps a normalized worker result', async () => {
    const redis = new FakeRedis();
    redis.autoResult = (jobId) => JSON.stringify({
      schema_version: 'lens.result.v1',
      job_id: jobId,
      status: 'succeeded',
      result: {
        search_metadata: { id: jobId, status: 'Success' },
        search_parameters: options,
        visual_matches: [{ position: 1, title: 'A result', link: 'https://example.test/item', source: 'example.test' }],
      },
    });
    const adapter = new ScraplingRedisAdapter({ client: redis, timeoutMs: 50, pollIntervalMs: 1 });
    const snapshot = await adapter.search({
      image: Buffer.from('must-not-be-published'),
      mimeType: 'image/png',
      imageId: '11111111-1111-4111-8111-111111111111',
      jobId: 'job-1',
      options,
    });

    expect(snapshot.links[0]).toMatchObject({ href: 'https://example.test/item', text: 'A result' });
    expect(redis.xaddCalls[0]).toMatchObject({ stream: 'lens:jobs:v1' });
    expect(redis.xaddCalls[0]?.fields).toContain('image_id');
    expect(redis.xaddCalls[0]?.fields).toContain('options_json');
    expect(redis.xaddCalls[0]?.fields).not.toContain('must-not-be-published');
    expect(adapter.contract()).toMatchObject({ stream: 'lens:jobs:v1', group: 'scrapling-workers' });
  });

  it('classifies worker challenge and overall timeout without direct browser work', async () => {
    const challenged = new FakeRedis();
    challenged.autoResult = () => JSON.stringify({ status: 'failed', error: { code: 'challenge', message: 'human check' } });
    const challengeAdapter = new ScraplingRedisAdapter({ client: challenged, timeoutMs: 50, pollIntervalMs: 1 });
    await expect(challengeAdapter.search({ image: Buffer.alloc(0), mimeType: 'image/png', imageId: 'image', jobId: 'challenge', options }))
      .rejects.toMatchObject({ code: 'lens_challenge', retryable: false });

    const timeoutAdapter = new ScraplingRedisAdapter({ client: new FakeRedis(), timeoutMs: 5, pollIntervalMs: 1 });
    await expect(timeoutAdapter.search({ image: Buffer.alloc(0), mimeType: 'image/png', imageId: 'image', jobId: 'timeout', options }))
      .rejects.toMatchObject({ code: 'lens_timeout', retryable: true });
  });

  it('hydrates persistence and refuses a late terminal overwrite after cancellation', async () => {
    const redis = new FakeRedis();
    const persistence = new RedisJobPersistence({ client: redis });
    await persistence.saveJob(job('job-1', 'queued'));
    await persistence.saveJob(job('job-1', 'cancelled'), { terminal: true });
    await persistence.saveJob({ ...job('job-1', 'succeeded'), result: { search_metadata: { id: 'job-1', status: 'Success' } as never, search_parameters: options, visual_matches: [] } }, { terminal: true });
    const hydrated = await persistence.hydrate();
    expect(hydrated.jobs).toHaveLength(1);
    expect(hydrated.jobs[0]?.state).toBe('cancelled');
    expect(hydrated.jobs[0]?.image.bytes).toHaveLength(0);
  });

  it('keeps the first terminal state when late worker paths race locally', () => {
    const store = new JobStore(10, 60_000);
    const created = store.createJob(payload(), options, undefined, '11111111-1111-4111-8111-111111111111');
    const result = {
      search_metadata: {
        id: created.id,
        status: 'Success' as const,
        json_endpoint: `/v1/jobs/${created.id}`,
        created_at: new Date(0).toISOString(),
        processed_at: new Date(0).toISOString(),
        total_time_taken: 0,
        cached: false,
        source: 'scrapling' as const,
      },
      search_parameters: options,
      visual_matches: [],
    };
    expect(store.succeed(created.id, result).state).toBe('succeeded');
    expect(store.fail(created.id, { code: 'late', message: 'late', retryable: true }).state).toBe('succeeded');
    expect(store.cancel(created.id).state).toBe('succeeded');
  });

  it('supports the Redis Streams consumer group and acknowledgement contract offline', async () => {
    const redis = new FakeRedis();
    redis.messages.push(['1-0', ['job_id', 'job-1', 'image_id', 'image-1', 'options_json', JSON.stringify(options)]]);
    const queue = new RedisStreamsJobQueue(10, { client: redis });
    const task = await queue.dequeue();
    expect(task).toMatchObject({ jobId: 'job-1', imageId: 'image-1', options });
    await queue.ack!(task!);
    expect(redis.groupCalls).toBe(1);
    expect(redis.xackCalls).toEqual(['1-0']);
  });
});
