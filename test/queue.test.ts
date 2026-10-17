import { describe, expect, it } from 'vitest';

import { QueueFullError } from '../src/domain/errors.js';
import { InMemoryJobQueue } from '../src/queue/in-memory-queue.js';

describe('InMemoryJobQueue', () => {
  it('enforces capacity and wakes a waiting worker', async () => {
    const queue = new InMemoryJobQueue(1);
    await queue.enqueue({ jobId: 'one' });
    await expect(queue.enqueue({ jobId: 'two' })).rejects.toBeInstanceOf(QueueFullError);
    expect(queue.size()).toBe(1);
    await expect(queue.dequeue()).resolves.toEqual({ jobId: 'one' });

    const waiting = queue.dequeue();
    await queue.enqueue({ jobId: 'three' });
    await expect(waiting).resolves.toEqual({ jobId: 'three' });
    await queue.close();
    await expect(queue.enqueue({ jobId: 'four' })).rejects.toThrow('closed');
  });
});
