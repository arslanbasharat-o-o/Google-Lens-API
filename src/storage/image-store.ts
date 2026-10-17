import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { NotFoundError } from '../domain/errors.js';
import { SUPPORTED_MIME_TYPES, type ImagePayload } from '../domain/types.js';

export interface StoredImageInfo {
  imageId: string;
  principal?: string;
  sha256: string;
  mimeType: ImagePayload['mimeType'];
  size: number;
  createdAt: string;
  expiresAt: string;
}

export interface ImageStoreContract {
  put(payload: ImagePayload, principal?: string): StoredImageInfo;
  get(imageId: string, principal?: string): ImagePayload;
  getInfo(imageId: string, principal?: string): StoredImageInfo;
  retain(imageId: string): void;
  ensureLease(imageId: string): void;
  release(imageId: string): void;
  cleanup(): number;
  delete(imageId: string): void;
  size(): number;
}

interface StoredImage {
  id: string;
  principal?: string;
  payload: ImagePayload;
  createdAt: number;
  expiresAt: number;
  leases: number;
}

/**
 * Short-retention image storage used by the HTTP compatibility endpoints.
 * Bytes never become public files or log fields. A production deployment can
 * replace this seam with encrypted object storage without changing routing.
 */
export class ImageStore implements ImageStoreContract {
  private readonly images = new Map<string, StoredImage>();
  private readonly byHash = new Map<string, string>();

  public constructor(
    private readonly retentionMs: number,
    private readonly maxRecords: number,
    private readonly now: () => number = Date.now,
  ) {}

  public put(payload: ImagePayload, principal?: string): StoredImageInfo {
    this.prune();
    const existingId = this.byHash.get(imageOwnerKey(payload.sha256, principal));
    if (existingId) {
      const existing = this.images.get(existingId);
      if (existing) return this.toStoredInfo(existing);
      this.byHash.delete(payload.sha256);
    }

    const createdAt = this.now();
    const stored: StoredImage = {
      id: randomUUID(),
      ...(principal ? { principal } : {}),
      payload: { ...payload, bytes: Buffer.from(payload.bytes) },
      createdAt,
      expiresAt: createdAt + this.retentionMs,
      leases: 0,
    };
    this.images.set(stored.id, stored);
    this.byHash.set(imageOwnerKey(payload.sha256, principal), stored.id);
    this.prune();
    return this.toStoredInfo(stored);
  }

  public get(imageId: string, principal?: string): ImagePayload {
    this.prune();
    const stored = this.images.get(imageId);
    if (!stored) throw new NotFoundError('image', imageId);
    assertImagePrincipal(stored.principal, principal, imageId);
    return { ...stored.payload, bytes: Buffer.from(stored.payload.bytes) };
  }

  public getInfo(imageId: string, principal?: string): StoredImageInfo {
    this.prune();
    const stored = this.images.get(imageId);
    if (!stored) throw new NotFoundError('image', imageId);
    assertImagePrincipal(stored.principal, principal, imageId);
    return this.toStoredInfo(stored);
  }

  public retain(imageId: string): void {
    const stored = this.images.get(imageId);
    if (!stored) throw new NotFoundError('image', imageId);
    stored.leases += 1;
  }

  public release(imageId: string): void {
    const stored = this.images.get(imageId);
    if (stored) stored.leases = Math.max(0, stored.leases - 1);
  }

  public ensureLease(imageId: string): void {
    const stored = this.images.get(imageId);
    if (!stored) throw new NotFoundError('image', imageId);
    stored.leases = Math.max(1, stored.leases);
  }

  public cleanup(): number {
    const before = this.images.size;
    this.prune();
    return Math.max(0, before - this.images.size);
  }

  public delete(imageId: string): void {
    const stored = this.images.get(imageId);
    if (!stored) return;
    this.images.delete(imageId);
    if (this.byHash.get(imageOwnerKey(stored.payload.sha256, stored.principal)) === imageId) {
      this.byHash.delete(imageOwnerKey(stored.payload.sha256, stored.principal));
    }
    stored.payload.bytes = Buffer.alloc(0);
  }

  public size(): number {
    this.prune();
    return this.images.size;
  }

  private toStoredInfo(stored: StoredImage): StoredImageInfo {
    return {
      imageId: stored.id,
      ...(stored.principal ? { principal: stored.principal } : {}),
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
      if (stored.expiresAt <= now && stored.leases === 0) this.delete(id);
    }
    if (this.images.size <= this.maxRecords) return;
    const oldest = [...this.images.values()]
      .filter((stored) => stored.leases === 0)
      .sort((left, right) => left.createdAt - right.createdAt);
    for (const stored of oldest) {
      if (this.images.size <= this.maxRecords) break;
      this.delete(stored.id);
    }
  }
}

interface FileImageMetadata extends StoredImageInfo {
  originalName?: string;
  width?: number;
  height?: number;
  leases?: number;
}

export interface FileImageStoreOptions {
  directory: string;
  retentionMs: number;
  maxRecords: number;
  now?: () => number;
}

/**
 * Durable, process-safe image store for production deployments.
 *
 * Each image has a private data file and a JSON metadata file. Both are named
 * from a generated UUID, data is written to a same-directory temporary file,
 * and the final names are installed with rename so readers never observe a
 * partially-written upload. The store never accepts a caller-supplied path.
 */
export class FileImageStore implements ImageStoreContract {
  public readonly directory: string;

  private readonly retentionMs: number;
  private readonly maxRecords: number;
  private readonly now: () => number;

  public constructor(options: FileImageStoreOptions);
  public constructor(directory: string, retentionMs: number, maxRecords: number, now?: () => number);
  public constructor(
    optionsOrDirectory: FileImageStoreOptions | string,
    retentionMs?: number,
    maxRecords?: number,
    now: () => number = Date.now,
  ) {
    if (typeof optionsOrDirectory === 'string') {
      if (retentionMs === undefined || maxRecords === undefined) {
        throw new Error('FileImageStore requires retentionMs and maxRecords.');
      }
      this.directory = resolve(optionsOrDirectory);
      this.retentionMs = retentionMs;
      this.maxRecords = maxRecords;
      this.now = now;
    } else {
      this.directory = resolve(optionsOrDirectory.directory);
      this.retentionMs = optionsOrDirectory.retentionMs;
      this.maxRecords = optionsOrDirectory.maxRecords;
      this.now = optionsOrDirectory.now ?? Date.now;
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.prune();
  }

  public put(payload: ImagePayload, principal?: string): StoredImageInfo {
    if (!Buffer.isBuffer(payload.bytes)) throw new TypeError('Image bytes must be a Buffer.');
    if (payload.size !== payload.bytes.byteLength) {
      throw new Error('Image metadata size does not match the supplied bytes.');
    }
    if (digest(payload.bytes) !== payload.sha256) {
      throw new Error('Image metadata sha256 does not match the supplied bytes.');
    }
    this.prune();
    const existing = this.findByHash(payload.sha256, principal);
    if (existing) return existing;

    const createdAt = this.now();
    const info: FileImageMetadata = {
      imageId: randomUUID(),
      ...(principal ? { principal } : {}),
      sha256: payload.sha256,
      mimeType: payload.mimeType,
      size: payload.size,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + this.retentionMs).toISOString(),
      ...(payload.originalName ? { originalName: payload.originalName } : {}),
      ...(payload.width !== undefined ? { width: payload.width } : {}),
      ...(payload.height !== undefined ? { height: payload.height } : {}),
    };
    const dataPath = this.dataPath(info.imageId);
    const metadataPath = this.metadataPath(info.imageId);
    const dataTemp = `${dataPath}.${process.pid}.${randomUUID()}.tmp`;
    const metadataTemp = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(dataTemp, payload.bytes, { flag: 'wx', mode: 0o600 });
      renameSync(dataTemp, dataPath);
      writeFileSync(metadataTemp, JSON.stringify(info), { flag: 'wx', mode: 0o600 });
      renameSync(metadataTemp, metadataPath);
    } catch (error) {
      this.removeFile(dataTemp);
      this.removeFile(metadataTemp);
      this.removeFile(dataPath);
      this.removeFile(metadataPath);
      throw error;
    }
    this.prune();
    return info;
  }

  public get(imageId: string, principal?: string): ImagePayload {
    this.prune();
    const metadata = this.readMetadata(imageId);
    if (!metadata) throw new NotFoundError('image', imageId);
    assertImagePrincipal(metadata.principal, principal, imageId);
    const bytesPath = this.dataPath(metadata.imageId);
    let bytes: Buffer;
    try {
      bytes = readFileSync(bytesPath);
      if (bytes.byteLength !== metadata.size || digest(bytes) !== metadata.sha256) {
        throw new Error('stored image integrity check failed');
      }
    } catch {
      this.delete(metadata.imageId);
      throw new NotFoundError('image', imageId);
    }
    return {
      bytes,
      mimeType: metadata.mimeType,
      ...(metadata.originalName ? { originalName: metadata.originalName } : {}),
      sha256: metadata.sha256,
      size: metadata.size,
      ...(metadata.width !== undefined ? { width: metadata.width } : {}),
      ...(metadata.height !== undefined ? { height: metadata.height } : {}),
    };
  }

  public getInfo(imageId: string, principal?: string): StoredImageInfo {
    this.prune();
    const metadata = this.readMetadata(imageId);
    if (!metadata) throw new NotFoundError('image', imageId);
    assertImagePrincipal(metadata.principal, principal, imageId);
    return this.toInfo(metadata);
  }

  public retain(imageId: string): void {
    const metadata = this.readMetadata(imageId);
    if (!metadata) throw new NotFoundError('image', imageId);
    metadata.leases = (metadata.leases ?? 0) + 1;
    this.writeMetadata(metadata);
  }

  public release(imageId: string): void {
    const metadata = this.readMetadata(imageId);
    if (!metadata) return;
    metadata.leases = Math.max(0, (metadata.leases ?? 0) - 1);
    this.writeMetadata(metadata);
  }

  public ensureLease(imageId: string): void {
    const metadata = this.readMetadata(imageId);
    if (!metadata) throw new NotFoundError('image', imageId);
    metadata.leases = Math.max(1, metadata.leases ?? 0);
    this.writeMetadata(metadata);
  }

  public delete(imageId: string): void {
    if (!isSafeImageId(imageId)) return;
    // The paths are derived only from a UUID and are checked against the
    // configured root before unlinking, so a malformed ID cannot escape it.
    this.removeFile(this.dataPath(imageId));
    this.removeFile(this.metadataPath(imageId));
  }

  public size(): number {
    this.prune();
    return this.metadataFiles().length;
  }

  /** Exposed for startup hooks and maintenance jobs. */
  public cleanup(): number {
    const before = this.metadataFiles().length;
    this.prune();
    return Math.max(0, before - this.metadataFiles().length);
  }

  public close(): void {
    this.prune();
  }

  private findByHash(sha256: string, principal?: string): StoredImageInfo | undefined {
    for (const filename of this.metadataFiles()) {
      const metadata = this.readMetadata(filename.slice(0, -'.json'.length));
      if (metadata?.sha256 === sha256 && metadata.principal === principal) {
        if (existsSync(this.dataPath(metadata.imageId))) return this.toInfo(metadata);
        this.delete(metadata.imageId);
      }
    }
    return undefined;
  }

  private prune(): void {
    if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const now = this.now();
    const records: FileImageMetadata[] = [];
    for (const filename of this.metadataFiles()) {
      const id = filename.slice(0, -'.json'.length);
      const metadata = this.readMetadata(id);
      if (!metadata) {
        this.delete(id);
        continue;
      }
      if (Date.parse(metadata.expiresAt) <= now && (metadata.leases ?? 0) === 0) {
        this.delete(id);
        continue;
      }
      records.push(metadata);
    }
    // A crash between the data rename and metadata rename can leave a private
    // orphan. Remove it during the same retention pass rather than retaining
    // unindexed bytes forever.
    for (const filename of readdirSync(this.directory)) {
      if (!isSafeImageId(filename) || this.readMetadata(filename)) continue;
      this.removeFile(this.dataPath(filename));
    }
    if (records.length <= this.maxRecords) return;
    records
      .filter((metadata) => (metadata.leases ?? 0) === 0)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .slice(0, Math.max(0, records.length - this.maxRecords))
      .forEach((metadata) => this.delete(metadata.imageId));
  }

  private metadataFiles(): string[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter((filename) => /^[-a-f0-9]{36}\.json$/i.test(filename));
  }

  private readMetadata(imageId: string): FileImageMetadata | undefined {
    if (!isSafeImageId(imageId)) return undefined;
    try {
      const value = JSON.parse(readFileSync(this.metadataPath(imageId), 'utf8')) as Partial<FileImageMetadata>;
      if (
        value.imageId !== imageId ||
        typeof value.sha256 !== 'string' ||
        typeof value.mimeType !== 'string' ||
        typeof value.size !== 'number' ||
        !/^[a-f0-9]{64}$/i.test(value.sha256) ||
        !SUPPORTED_MIME_TYPES.includes(value.mimeType as ImagePayload['mimeType']) ||
        typeof value.createdAt !== 'string' ||
        typeof value.expiresAt !== 'string'
        || (value.principal !== undefined && typeof value.principal !== 'string')
      ) return undefined;
      return value as FileImageMetadata;
    } catch {
      return undefined;
    }
  }

  private toInfo(metadata: FileImageMetadata): StoredImageInfo {
    return {
      imageId: metadata.imageId,
      ...(metadata.principal ? { principal: metadata.principal } : {}),
      sha256: metadata.sha256,
      mimeType: metadata.mimeType,
      size: metadata.size,
      createdAt: metadata.createdAt,
      expiresAt: metadata.expiresAt,
    };
  }

  private writeMetadata(metadata: FileImageMetadata): void {
    const path = this.metadataPath(metadata.imageId);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      this.removeFile(temporary);
    }
  }

  private dataPath(imageId: string): string {
    // The bare image ID is the cross-language worker contract: the Scrapling
    // worker resolves IMAGE_STORAGE_DIR/<image_id> without guessing an extension.
    return this.safePath(imageId);
  }

  private metadataPath(imageId: string): string {
    return this.safePath(`${imageId}.json`);
  }

  private safePath(filename: string): string {
    const path = resolve(this.directory, filename);
    const relativePath = relative(this.directory, path);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error('Image path escaped IMAGE_STORAGE_DIR.');
    }
    return path;
  }

  private removeFile(path: string): void {
    try {
      const relativePath = relative(this.directory, resolve(path));
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) return;
      if (existsSync(path) && statSync(path).isDirectory()) return;
      rmSync(path, { force: true });
    } catch {
      // Retention cleanup is best effort; a later operation can retry it.
    }
  }
}

export { FileImageStore as ProductionImageStore };

function isSafeImageId(imageId: string): boolean {
  return /^[-a-f0-9]{36}$/i.test(imageId);
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function imageOwnerKey(sha256: string, principal?: string): string {
  return `${principal ?? 'public'}:${sha256}`;
}

function assertImagePrincipal(owner: string | undefined, principal: string | undefined, imageId: string): void {
  if (owner && owner !== principal) throw new NotFoundError('image', imageId);
}
