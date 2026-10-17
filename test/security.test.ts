import { describe, expect, it, vi } from 'vitest';

import { RemoteFetchError } from '../src/domain/errors.js';
import {
  isPrivateAddress,
  RemoteImageFetcher,
  type RemoteImageFetcherOptions,
  type RemoteImageResponse,
} from '../src/services/remote-image.js';
import { normalizeUpload } from '../src/http/uploads.js';
import { representativePng } from './image-fixture.js';

describe('image and remote URL safety boundaries', () => {
  it('rejects a declared image whose header dimensions exceed the pixel limit', () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(20_000, 16);
    png.writeUInt32BE(20_000, 20);
    expect(() => normalizeUpload(png, 'image/png', 'large.png', 1024 * 1024, 1_000_000, 50_000)).toThrow(
      /pixel count/i,
    );
  });

  it('accepts a valid representative PNG and records its bounded dimensions', () => {
    const png = representativePng(256, 192);
    const image = normalizeUpload(png, 'image/png', 'representative.png', 1024 * 1024, 40_000_000, 10_000);
    expect(image.size).toBe(png.length);
    expect(image.size).toBeGreaterThan(1_000);
    expect(image.width).toBe(256);
    expect(image.height).toBe(192);
  });

  it('blocks localhost before opening a network request', async () => {
    const requestMock = vi.fn();
    const fetcher = new RemoteImageFetcher({
      timeoutMs: 100,
      maxBytes: 1024,
      maxRedirects: 1,
      maxPixels: 1_000_000,
      maxDimension: 2_000,
      request: requestMock,
    });
    await expect(fetcher.fetchImage('http://127.0.0.1/private.png')).rejects.toBeInstanceOf(RemoteFetchError);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it.each([
    '::1',
    'fc00::1',
    'fe80::1',
    'fec0::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.1',
    '::ffff:c0a8:0101',
  ])('blocks private IPv6 or IPv4-mapped address %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it('does not classify a mapped public IPv4 address as private', () => {
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('pins a validated DNS address and revalidates every redirect destination', async () => {
    const image = representativePng(32, 32);
    const answers: Record<string, Array<{ address: string; family: 4 | 6 }>> = {
      'public.example.test': [{ address: '93.184.216.34', family: 4 }],
      'private.example.test': [{ address: '::ffff:127.0.0.1', family: 6 }],
    };
    const dnsLookup: NonNullable<RemoteImageFetcherOptions['dnsLookup']> = async (hostname) => answers[hostname] ?? [];
    const requests: Array<{ hostname: string; address: string }> = [];
    const request: NonNullable<RemoteImageFetcherOptions['request']> = async (url, resolvedHost) => {
      requests.push({ hostname: url.hostname, address: resolvedHost.address });
      return {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(image.length) },
        body: image,
      } satisfies RemoteImageResponse;
    };
    const fetcher = new RemoteImageFetcher({
      timeoutMs: 100,
      maxBytes: 1024 * 1024,
      maxRedirects: 1,
      maxPixels: 1_000_000,
      maxDimension: 2_000,
      dnsLookup,
      request,
    });

    const result = await fetcher.fetchImage('http://public.example.test/image.png');
    expect(result.width).toBe(32);
    expect(requests).toEqual([{ hostname: 'public.example.test', address: '93.184.216.34' }]);

    const redirectRequests: string[] = [];
    const redirectFetcher = new RemoteImageFetcher({
      timeoutMs: 100,
      maxBytes: 1024 * 1024,
      maxRedirects: 1,
      maxPixels: 1_000_000,
      maxDimension: 2_000,
      dnsLookup,
      request: async (url) => {
        redirectRequests.push(url.hostname);
        return { status: 302, headers: { location: 'http://private.example.test/image.png' } };
      },
    });
    await expect(redirectFetcher.fetchImage('http://public.example.test/redirect')).rejects.toMatchObject({
      code: 'remote_fetch_error',
    });
    expect(redirectRequests).toEqual(['public.example.test']);
  });

  it('retains remote byte and timeout bounds', async () => {
    const dnsLookup: NonNullable<RemoteImageFetcherOptions['dnsLookup']> = async () => [
      { address: '93.184.216.34', family: 4 },
    ];
    const oversized = new RemoteImageFetcher({
      timeoutMs: 100,
      maxBytes: 32,
      maxRedirects: 0,
      maxPixels: 1_000_000,
      maxDimension: 2_000,
      dnsLookup,
      request: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.alloc(33) }),
    });
    await expect(oversized.fetchImage('http://public.example.test/image.png')).rejects.toMatchObject({
      code: 'remote_fetch_error',
      retryable: false,
    });

    const slow = new RemoteImageFetcher({
      timeoutMs: 5,
      maxBytes: 1024,
      maxRedirects: 0,
      maxPixels: 1_000_000,
      maxDimension: 2_000,
      dnsLookup,
      request: async () => new Promise<RemoteImageResponse>((resolve) => {
        setTimeout(() => resolve({ status: 200, headers: { 'content-type': 'image/png' }, body: representativePng(1, 1) }), 25);
      }),
    });
    await expect(slow.fetchImage('http://public.example.test/slow.png')).rejects.toMatchObject({
      code: 'remote_fetch_error',
      retryable: true,
      message: 'The remote image request timed out.',
    });
  });
});
