import { describe, expect, it, vi } from 'vitest';

import { BrowserPool } from '../src/browser/browser-pool.js';

function fakeBrowser() {
  let connected = true;
  const browser = {
    isConnected: () => connected,
    newContext: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
    close: vi.fn(async () => {
      connected = false;
    }),
    on: vi.fn(),
  };
  return browser;
}

describe('BrowserPool', () => {
  it('reuses a bounded process while giving each job a fresh context', async () => {
    const browsers = [fakeBrowser(), fakeBrowser()];
    let index = 0;
    const launcher = vi.fn(async () => browsers[index++]!);
    const pool = new BrowserPool(
      {
        headless: true,
        minProcesses: 1,
        maxProcesses: 1,
        contextsPerProcess: 2,
        recycleAfterJobs: 100,
      },
      launcher,
    );

    let firstContext: unknown;
    let secondContext: unknown;
    await pool.withContext(async ({ context }) => {
      firstContext = context;
    });
    await pool.withContext(async ({ context }) => {
      secondContext = context;
    });

    expect(launcher).toHaveBeenCalledTimes(1);
    expect(firstContext).not.toBe(secondContext);
    expect(browsers[0]!.newContext).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it('recycles a process after the configured job budget', async () => {
    const browsers = [fakeBrowser(), fakeBrowser()];
    let index = 0;
    const launcher = vi.fn(async () => browsers[index++]!);
    const pool = new BrowserPool(
      {
        headless: true,
        minProcesses: 1,
        maxProcesses: 1,
        contextsPerProcess: 1,
        recycleAfterJobs: 1,
      },
      launcher,
    );

    await pool.withContext(async () => undefined);
    await pool.withContext(async () => undefined);

    expect(launcher).toHaveBeenCalledTimes(2);
    expect(browsers[0]!.close).toHaveBeenCalled();
    await pool.close();
  });
});
