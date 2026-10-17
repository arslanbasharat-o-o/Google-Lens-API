export interface ResultCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  size(): number;
  clear(): void;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  touchedAt: number;
}

export class MemoryResultCache<T> implements ResultCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  public constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  public get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    entry.touchedAt = this.now();
    return entry.value;
  }

  public set(key: string, value: T): void {
    const now = this.now();
    this.entries.set(key, { value, expiresAt: now + this.ttlMs, touchedAt: now });
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.entries()].sort(
        ([, left], [, right]) => left.touchedAt - right.touchedAt,
      )[0];
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
  }

  public size(): number {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.entries.delete(key);
    }
    return this.entries.size;
  }

  public clear(): void {
    this.entries.clear();
  }
}
