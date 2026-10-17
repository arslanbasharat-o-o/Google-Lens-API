import type { Browser, BrowserContext } from 'playwright';

export interface BrowserPoolOptions {
  headless: boolean;
  minProcesses: number;
  maxProcesses: number;
  contextsPerProcess: number;
  recycleAfterJobs: number;
}

export interface BrowserLease {
  context: BrowserContext;
  startupMs: number;
  processNumber: number;
}

export type BrowserLauncher = (options: { headless: boolean }) => Promise<Browser>;

interface BrowserSlot {
  browser: Browser;
  processNumber: number;
  contextsInUse: number;
  jobs: number;
  startupMs: number;
}

interface Waiter {
  resolve: (slot: BrowserSlot) => void;
  reject: (error: Error) => void;
}

/**
 * Reuses a bounded number of browser processes and leases isolated contexts
 * per job. A context is always closed by the lease owner; browser recycling is
 * triggered after a configurable number of completed jobs or a disconnect.
 */
export class BrowserPool {
  private readonly slots: BrowserSlot[] = [];
  private readonly waiters: Waiter[] = [];
  private started = false;
  private stopping = false;
  private nextProcessNumber = 1;

  public constructor(
    private readonly options: BrowserPoolOptions,
    private readonly launchBrowser: BrowserLauncher,
  ) {}

  public async start(): Promise<void> {
    if (this.started || this.stopping) return;
    this.started = true;
    for (let index = 0; index < this.options.minProcesses; index += 1) {
      await this.createSlot();
    }
  }

  public async withContext<T>(callback: (lease: BrowserLease) => Promise<T>): Promise<T> {
    if (!this.started) await this.start();
    const slot = await this.acquireSlot();
    let context: BrowserContext | undefined;
    try {
      context = await slot.browser.newContext();
      return await callback({
        context,
        startupMs: slot.startupMs,
        processNumber: slot.processNumber,
      });
    } finally {
      await context?.close().catch(() => undefined);
      await this.releaseSlot(slot);
    }
  }

  public async close(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const error = new Error('Browser pool is stopping.');
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    await Promise.all(this.slots.splice(0).map((slot) => slot.browser.close().catch(() => undefined)));
  }

  public processCount(): number {
    return this.slots.length;
  }

  private async acquireSlot(): Promise<BrowserSlot> {
    if (this.stopping) throw new Error('Browser pool is stopping.');
    const available = this.slots.find(
      (slot) => slot.browser.isConnected() && slot.contextsInUse < this.options.contextsPerProcess,
    );
    if (available) {
      available.contextsInUse += 1;
      available.jobs += 1;
      return available;
    }
    if (this.slots.length < this.options.maxProcesses) {
      const slot = await this.createSlot();
      slot.contextsInUse += 1;
      slot.jobs += 1;
      return slot;
    }
    return new Promise<BrowserSlot>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private async releaseSlot(slot: BrowserSlot): Promise<void> {
    slot.contextsInUse = Math.max(0, slot.contextsInUse - 1);
    if (!slot.browser.isConnected()) {
      await this.discardSlot(slot);
    } else if (slot.contextsInUse === 0 && slot.jobs >= this.options.recycleAfterJobs) {
      await this.discardSlot(slot);
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      try {
        const replacement = await this.acquireSlot();
        waiter.resolve(replacement);
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async createSlot(): Promise<BrowserSlot> {
    if (this.stopping) throw new Error('Browser pool is stopping.');
    const createdAt = Date.now();
    const browser = await this.launchBrowser({ headless: this.options.headless });
    const slot: BrowserSlot = {
      browser,
      processNumber: this.nextProcessNumber++,
      contextsInUse: 0,
      jobs: 0,
      startupMs: Math.max(0, Date.now() - createdAt),
    };
    this.slots.push(slot);
    browser.on('disconnected', () => {
      void this.discardSlot(slot);
    });
    return slot;
  }

  private async discardSlot(slot: BrowserSlot): Promise<void> {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    await slot.browser.close().catch(() => undefined);
  }
}
