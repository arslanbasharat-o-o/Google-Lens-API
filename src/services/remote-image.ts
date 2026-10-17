import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { RemoteFetchError } from '../domain/errors.js';
import type { ImagePayload } from '../domain/types.js';
import { normalizeUpload } from '../http/uploads.js';

const SUPPORTED_REMOTE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface RemoteImageFetcherOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  maxPixels: number;
  maxDimension: number;
}

/**
 * Fetches a caller-supplied image URL with explicit SSRF defenses. Redirects
 * are followed manually so every destination is checked before a request.
 */
export class RemoteImageFetcher {
  public constructor(private readonly options: RemoteImageFetcherOptions) {}

  public async fetchImage(inputUrl: string): Promise<ImagePayload> {
    let current = this.validateUrl(inputUrl);
    for (let redirect = 0; redirect <= this.options.maxRedirects; redirect += 1) {
      await assertPublicHost(current.hostname);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      let response: Response;
      try {
        response = await fetch(current, { redirect: 'manual', signal: controller.signal });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) throw new RemoteFetchError('The remote image redirect had no destination.');
          if (redirect === this.options.maxRedirects) {
            throw new RemoteFetchError('The remote image exceeded the redirect limit.');
          }
          current = this.validateUrl(new URL(location, current).toString());
          continue;
        }

        if (!response.ok) {
          throw new RemoteFetchError(`The remote image returned HTTP ${response.status}.`, response.status >= 500);
        }

        const declaredMime = ((response.headers.get('content-type') ?? '').split(';', 1)[0] ?? '').trim().toLowerCase();
        if (declaredMime && !SUPPORTED_REMOTE_MIME.has(declaredMime)) {
          throw new RemoteFetchError('The remote image content type is not supported.', false, {
            content_type: declaredMime,
          });
        }
        const contentLength = Number(response.headers.get('content-length') ?? 0);
        if (Number.isFinite(contentLength) && contentLength > this.options.maxBytes) {
          throw new RemoteFetchError('The remote image exceeds the configured size limit.');
        }

        const bytes = await readBoundedBody(response, this.options.maxBytes, controller.signal);
        const mime = declaredMime || 'application/octet-stream';
        return normalizeUpload(
          bytes,
          mime,
          new URL(current).pathname.split('/').pop() || 'remote-image',
          this.options.maxBytes,
          this.options.maxPixels,
          this.options.maxDimension,
        );
      } catch (error) {
        if (error instanceof RemoteFetchError) throw error;
        if (controller.signal.aborted) {
          throw new RemoteFetchError('The remote image request timed out.', true);
        }
        throw new RemoteFetchError('The remote image could not be fetched.', true, {
          reason: error instanceof Error ? error.message : 'network_error',
        });
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new RemoteFetchError('The remote image could not be fetched.');
  }

  private validateUrl(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new RemoteFetchError('The image URL is invalid.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new RemoteFetchError('Only http and https image URLs are supported.');
    }
    if (url.username || url.password) {
      throw new RemoteFetchError('Image URLs with embedded credentials are not allowed.');
    }
    return url;
  }
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new RemoteFetchError('The remote image exceeds the configured size limit.');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new RemoteFetchError('The remote image request timed out.', true);
    }
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RemoteFetchError('The remote image exceeds the configured size limit.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function assertPublicHost(hostname: string): Promise<void> {
  const normalized = hostname.replace(/\.$/, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    throw new RemoteFetchError('Private and local image hosts are not allowed.');
  }
  let addresses: string[];
  try {
    addresses = isIP(normalized)
      ? [normalized]
      : (await lookup(normalized, { all: true, verbatim: true })).map((entry) => entry.address);
  } catch {
    throw new RemoteFetchError('The image host could not be resolved.');
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new RemoteFetchError('Private and link-local image hosts are not allowed.');
  }
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const [first = 0, second = 0] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    );
  }
  const normalized = address.toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('::ffff:127.')
  );
}
