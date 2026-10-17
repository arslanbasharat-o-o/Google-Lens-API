import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../domain/errors.js';
import type { ImagePayload } from '../domain/types.js';

export interface StoredImageInfo {
  imageId: string;
  sha256: string;
  mimeType: ImagePayload['mimeType'];
  size: number;
  createdAt: string;
  expiresAt: string;
}

interface StoredImage {
  id: string;
  payload: ImagePayload;
  createdAt: number;
  expiresAt: number;
}

/**
 * Short-retention image storage used by the HTTP compatibility endpoints.
 * Bytes never become public files or log fields. A production deployment can
 * replace this seam with encrypted object storage without changing routing.
 */
export class ImageStore {
  private readonly images = new Map<string, StoredImage>();
  private readonly byHash = new Map<string, string>();

  public constructor(
    private readonly retentionMs: number,
    private readonly maxRecords: number,
    private readonly now: () => number = Date.now,
  ) {}

  public put(payload: ImagePayload): StoredImageInfo {
    this.prune();
    const existingId = this.byHash.get(payload.sha256);
    if (existingId) {
      const existing = this.images.get(existingId);
      if (existing) return this.toInfo(existing);
      this.byHash.delete(payload.sha256);
    }

    const createdAt = this.now();
    const stored: StoredImage = {
      id: randomUUID(),
      payload: { ...payload, bytes: Buffer.from(payload.bytes) },
      createdAt,
      expiresAt: createdAt + this.retentionMs,
    };
    this.images.set(stored.id, stored);
    this.byHash.set(payload.sha256, stored.id);
    this.prune();
    return this.toInfo(stored);
  }

  public get(imageId: string): ImagePayload {
    this.prune();
    const stored = this.images.get(imageId);
    if (!stored) throw new NotFoundError('image', imageId);
    return { ...stored.payload, bytes: Buffer.from(stored.payload.bytes) };
  }

  public getInfo(imageId: string): StoredImageInfo {
    this.prune();
    const stored = this.images.get(imageId);
    if (!stored) throw new NotFoundError('image', imageId);
    return this.toInfo(stored);
  }

  public delete(imageId: string): void {
    const stored = this.images.get(imageId);
    if (!stored) return;
    this.images.delete(imageId);
    if (this.byHash.get(stored.payload.sha256) === imageId) {
      this.byHash.delete(stored.payload.sha256);
    }
    stored.payload.bytes = Buffer.alloc(0);
  }

  public size(): number {
    this.prune();
    return this.images.size;
  }

  private toInfo(stored: StoredImage): StoredImageInfo {
    return {
      imageId: stored.id,
      sha256: stored.payload.sha256,
      mimeType: stored.payload.mimeType,
      size: stored.payload.size,
      createdAt: new Date(stored.createdAt).toISOString(),
      expiresAt: new Date(stored.expiresAt).toISOString(),
    };
  }

  private prune(): void {
    const now = this.now();
    for (const [id, stored] of this.images) {
      if (stored.expiresAt <= now) this.delete(id);
    }
    if (this.images.size <= this.maxRecords) return;
    const oldest = [...this.images.values()].sort((left, right) => left.createdAt - right.createdAt);
    for (const stored of oldest) {
      if (this.images.size <= this.maxRecords) break;
      this.delete(stored.id);
    }
  }
}
