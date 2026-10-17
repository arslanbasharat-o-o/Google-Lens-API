import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('deployment configuration', () => {
  it('rejects a Scrapling API with a disabled worker or in-memory image store', () => {
    expect(() => loadConfig({
      NODE_ENV: 'development',
      LENS_ADAPTER: 'scrapling',
      SCRAPLING_WORKER_MODE: 'disabled',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
    })).toThrow(/requires SCRAPLING_WORKER_MODE=fixture or live/);
    expect(() => loadConfig({
      NODE_ENV: 'development',
      LENS_ADAPTER: 'scrapling',
      SCRAPLING_WORKER_MODE: 'fixture',
      IMAGE_STORAGE_BACKEND: 'memory',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
    })).toThrow(/IMAGE_STORAGE_BACKEND=file/);
  });

  it('requires a key whenever authentication is enabled', () => {
    expect(() => loadConfig({
      NODE_ENV: 'development',
      API_AUTH_REQUIRED: 'true',
    })).toThrow(/API_KEYS must contain at least one secret/);
  });

  it('requires live gates only in the explicit live mode', () => {
    expect(() => loadConfig({
      NODE_ENV: 'development',
      LENS_ADAPTER: 'scrapling',
      SCRAPLING_WORKER_MODE: 'fixture',
      IMAGE_STORAGE_BACKEND: 'file',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
      GOOGLE_LENS_LIVE_ENABLED: 'true',
    })).toThrow(/authorization variables require SCRAPLING_WORKER_MODE=live/);

    const config = loadConfig({
      NODE_ENV: 'development',
      LENS_ADAPTER: 'scrapling',
      SCRAPLING_WORKER_MODE: 'fixture',
      IMAGE_STORAGE_BACKEND: 'file',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
    });
    expect(config.liveAutomationEnabled).toBe(false);
  });
});
