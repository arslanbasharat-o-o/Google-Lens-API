import { type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions as HttpRequestOptions,
} from 'node:http';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';

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
  /** Injectable only for deterministic tests; production uses node:dns. */
  dnsLookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;
  /** Injectable only for deterministic tests; production uses pinned HTTP(S). */
  request?: RemoteImageRequest;
}

export interface ResolvedRemoteHost {
  address: string;
  family: 4 | 6;
}

export type RemoteHeaders = Record<string, string | string[] | undefined>;

export interface RemoteImageResponse {
  status: number;
  headers: RemoteHeaders;
  body?: Buffer;
}

export type RemoteImageRequest = (
  url: URL,
  resolvedHost: ResolvedRemoteHost,
  maxBytes: number,
  timeoutMs: number,
) => Promise<RemoteImageResponse>;

/**
 * Fetches a caller-supplied image URL with explicit SSRF defenses. Redirects
 * are followed manually so every destination is checked before a request.
 *
 * A hostname is resolved once immediately before each request. The validated
 * address is then supplied through Node's lookup hook, so the HTTP client
 * cannot perform a second DNS lookup after the private-network check.
 */
export class RemoteImageFetcher {
  private readonly dnsLookup: NonNullable<RemoteImageFetcherOptions['dnsLookup']>;
  private readonly requestImage: RemoteImageRequest;

  public constructor(private readonly options: RemoteImageFetcherOptions) {
    this.dnsLookup = options.dnsLookup ?? lookup;
    this.requestImage = options.request ?? requestRemoteImage;
  }

  public async fetchImage(inputUrl: string): Promise<ImagePayload> {
    let current = this.validateUrl(inputUrl);
    for (let redirect = 0; redirect <= this.options.maxRedirects; redirect += 1) {
      const resolvedHost = await resolvePublicHost(current.hostname, this.dnsLookup);
      try {
        const response = await withTimeout(
          this.requestImage(
            current,
            resolvedHost,
            this.options.maxBytes,
            this.options.timeoutMs,
          ),
          this.options.timeoutMs,
        );
        if (response.status >= 300 && response.status < 400) {
          const location = headerValue(response.headers, 'location');
          if (!location) throw new RemoteFetchError('The remote image redirect had no destination.');
          if (redirect === this.options.maxRedirects) {
            throw new RemoteFetchError('The remote image exceeded the redirect limit.');
          }
          let destination: URL;
          try {
            destination = new URL(location, current);
          } catch {
            throw new RemoteFetchError('The remote image redirect destination is invalid.');
          }
          current = this.validateUrl(destination.toString());
          continue;
        }

        if (response.status < 200 || response.status >= 300) {
          throw new RemoteFetchError(`The remote image returned HTTP ${response.status}.`, response.status >= 500);
        }

        const declaredMime = (headerValue(response.headers, 'content-type') ?? '')
          .split(';', 1)[0]
          ?.trim()
          .toLowerCase() ?? '';
        if (declaredMime && !SUPPORTED_REMOTE_MIME.has(declaredMime)) {
          throw new RemoteFetchError('The remote image content type is not supported.', false, {
            content_type: declaredMime,
          });
        }
        const contentLength = Number(headerValue(response.headers, 'content-length') ?? 0);
        if (Number.isFinite(contentLength) && contentLength > this.options.maxBytes) {
          throw new RemoteFetchError('The remote image exceeds the configured size limit.');
        }
        if (response.body && response.body.length > this.options.maxBytes) {
          throw new RemoteFetchError('The remote image exceeds the configured size limit.');
        }

        const bytes = response.body ?? Buffer.alloc(0);
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
        throw new RemoteFetchError('The remote image could not be fetched.', true, {
          reason: error instanceof Error ? error.message : 'network_error',
        });
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

async function resolvePublicHost(
  hostname: string,
  dnsLookup: NonNullable<RemoteImageFetcherOptions['dnsLookup']>,
): Promise<ResolvedRemoteHost> {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    throw new RemoteFetchError('Private and local image hosts are not allowed.');
  }
  let addresses: LookupAddress[];
  try {
    addresses = isIP(normalized)
      ? [{ address: normalized, family: isIP(normalized) as 4 | 6 }]
      : await dnsLookup(normalized, { all: true, verbatim: true });
  } catch {
    throw new RemoteFetchError('The image host could not be resolved.');
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new RemoteFetchError('Private and link-local image hosts are not allowed.');
  }
  const first = addresses[0];
  if (!first) throw new RemoteFetchError('The image host could not be resolved.');
  const family = isIP(first.address);
  if (family !== 4 && family !== 6) throw new RemoteFetchError('The image host could not be resolved.');
  return { address: first.address, family };
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase();
}

async function requestRemoteImage(
  url: URL,
  resolvedHost: ResolvedRemoteHost,
  maxBytes: number,
  timeoutMs: number,
): Promise<RemoteImageResponse> {
  return new Promise<RemoteImageResponse>((resolve, reject) => {
    let request: ClientRequest | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let timedOut = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    const fail = (error: unknown): void => {
      finish(() => reject(error));
    };

    const onResponse = (response: IncomingMessage): void => {
      const status = response.statusCode ?? 0;
      const contentLength = Number(headerValue(response.headers, 'content-length') ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        discardResponse(response);
        fail(new RemoteFetchError('The remote image exceeds the configured size limit.'));
        return;
      }
      if (status >= 300 && status < 400) {
        // Redirect bodies are never needed. Abort them without retaining bytes
        // so a redirect cannot bypass the response byte limit.
        discardResponse(response);
        finish(() => resolve({ status, headers: response.headers }));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      const responseStream = response as IncomingMessage & {
        on(event: string, listener: (...args: any[]) => void): IncomingMessage;
        once(event: string, listener: (...args: any[]) => void): IncomingMessage;
      };
      responseStream.on('data', (value: Buffer | string) => {
        if (settled) return;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          fail(new RemoteFetchError('The remote image exceeds the configured size limit.'));
          response.destroy();
          request?.destroy();
          return;
        }
        chunks.push(chunk);
      });
      responseStream.once('end', () => {
        finish(() => resolve({ status, headers: response.headers, body: Buffer.concat(chunks, total) }));
      });
      responseStream.once('aborted', () => {
        if (!settled) fail(new RemoteFetchError('The remote image response was interrupted.', true));
      });
      responseStream.once('error', (error: unknown) => {
        if (!settled) fail(new RemoteFetchError('The remote image could not be read.', true, {
          reason: error instanceof Error ? error.message : 'response_error',
        }));
      });
    };

    const options: HttpRequestOptions = {
      protocol: url.protocol,
      hostname: normalizeHostname(url.hostname),
      ...(url.port ? { port: url.port } : {}),
      path: `${url.pathname || '/'}${url.search}`,
      method: 'GET',
      headers: {
        accept: 'image/jpeg,image/png,image/webp,application/octet-stream;q=0.5',
        host: url.host,
      },
      // The resolver result is captured for this request. The HTTP client is
      // not allowed to perform a second DNS lookup that could rebind a public
      // hostname to a private address between validation and connect.
      lookup: (_hostname, _options, callback) => callback(null, resolvedHost.address, resolvedHost.family),
    };

    try {
      request = url.protocol === 'https:'
        ? httpsRequest({ ...options, servername: normalizeHostname(url.hostname) }, onResponse)
        : httpRequest(options, onResponse);
      request.once('error', (error) => {
        if (settled) return;
        if (timedOut) {
          fail(new RemoteFetchError('The remote image request timed out.', true));
          return;
        }
        fail(new RemoteFetchError('The remote image could not be fetched.', true, {
          reason: error instanceof Error ? error.message : 'network_error',
        }));
      });
      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        request?.destroy();
        fail(new RemoteFetchError('The remote image request timed out.', true));
      }, timeoutMs);
      request.end();
    } catch (error) {
      fail(new RemoteFetchError('The remote image could not be fetched.', true, {
        reason: error instanceof Error ? error.message : 'network_error',
      }));
    }
  });
}

function headerValue(headers: RemoteHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new RemoteFetchError('The remote image request timed out.', true)), timeoutMs);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function discardResponse(response: IncomingMessage): void {
  (response as IncomingMessage & {
    once(event: string, listener: (...args: any[]) => void): IncomingMessage;
  }).once('error', () => undefined);
  response.destroy();
}

/** Return true for non-public addresses, including IPv4-mapped IPv6 forms. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family !== 6) return true;

  const words = parseIPv6(address);
  if (!words) return true;
  if (isIPv4Mapped(words)) return isPrivateIPv4(wordsToIPv4(words[6]!, words[7]!));

  const first = words[0]!;
  const second = words[1]!;
  return (
    words.every((word) => word === 0) ||
    (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && second === 0x0db8)
  );
}

function isPrivateIPv4(address: string): boolean {
  const octets = parseIPv4(address);
  if (!octets) return true;
  const [first = 0, second = 0, third = 0] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseIPv4(address: string): [number, number, number, number] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return undefined;
  return octets as [number, number, number, number];
}

function parseIPv6(address: string): number[] | undefined {
  const value = address.replace(/^\[/, '').replace(/\]$/, '').split('%', 1)[0] ?? '';
  const embedded = value.includes('.') ? value.slice(value.lastIndexOf(':') + 1) : undefined;
  const normalized = embedded
    ? `${value.slice(0, value.lastIndexOf(':'))}:${ipv4AsHex(embedded)}`
    : value;
  const sections = normalized.split('::');
  if (sections.length > 2) return undefined;
  const left = parseIPv6Sections(sections[0] ?? '');
  const right = sections.length === 2 ? parseIPv6Sections(sections[1] ?? '') : [];
  if (!left || !right) return undefined;
  if (sections.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIPv6Sections(value: string): number[] | undefined {
  if (!value) return [];
  const sections = value.split(':');
  if (sections.some((section) => !/^[0-9a-f]{1,4}$/i.test(section))) return undefined;
  return sections.map((section) => Number.parseInt(section, 16));
}

function ipv4AsHex(value: string): string {
  const octets = parseIPv4(value);
  if (!octets) return 'invalid';
  const high = ((octets[0]! << 8) | octets[1]!).toString(16).padStart(4, '0');
  const low = ((octets[2]! << 8) | octets[3]!).toString(16).padStart(4, '0');
  return `${high}:${low}`;
}

function isIPv4Mapped(words: number[]): boolean {
  return words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
}

function wordsToIPv4(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}
