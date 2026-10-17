import { describe, expect, it, vi } from 'vitest';

import { RemoteFetchError } from '../src/domain/errors.js';
import { RemoteImageFetcher } from '../src/services/remote-image.js';
import { normalizeUpload } from '../src/http/uploads.js';

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

  it('blocks localhost before calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const fetcher = new RemoteImageFetcher({
      timeoutMs: 100,
      maxBytes: 1024,
      maxRedirects: 1,
      maxPixels: 1_000_000,
      maxDimension: 2_000,
    });
    await expect(fetcher.fetchImage('http://127.0.0.1/private.png')).rejects.toBeInstanceOf(RemoteFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
