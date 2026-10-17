import { basename } from 'node:path';

import { ValidationError } from '../domain/errors.js';
import {
  SUPPORTED_MIME_TYPES,
  type ImagePayload,
  type SupportedMimeType,
} from '../domain/types.js';
import { sha256 } from '../services/hash.js';

export function detectImageMime(bytes: Buffer): SupportedMimeType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

export function normalizeUpload(
  bytes: Buffer,
  declaredMime: string,
  filename: string | undefined,
  maxBytes: number,
  maxPixels = 40_000_000,
  maxDimension = 10_000,
): ImagePayload {
  if (bytes.length === 0) throw new ValidationError('The image upload is empty.');
  if (bytes.length > maxBytes) {
    throw new ValidationError(`The image exceeds the ${maxBytes}-byte upload limit.`);
  }
  const sniffed = detectImageMime(bytes);
  if (!sniffed || !SUPPORTED_MIME_TYPES.includes(sniffed)) {
    throw new ValidationError('The upload is not a supported JPEG, PNG, or WebP image.');
  }
  if (declaredMime !== 'application/octet-stream' && declaredMime !== sniffed) {
    throw new ValidationError('The multipart content type does not match the image bytes.', {
      declared_mime: declaredMime,
      detected_mime: sniffed,
    });
  }
  const dimensions = inspectImageDimensions(bytes, sniffed);
  if (dimensions && (dimensions.width > maxDimension || dimensions.height > maxDimension)) {
    throw new ValidationError('The image dimensions exceed the configured safety limit.', {
      width: dimensions.width,
      height: dimensions.height,
      max_dimension: maxDimension,
    });
  }
  if (dimensions && dimensions.width * dimensions.height > maxPixels) {
    throw new ValidationError('The image pixel count exceeds the configured safety limit.', {
      width: dimensions.width,
      height: dimensions.height,
      max_pixels: maxPixels,
    });
  }
  return {
    bytes,
    mimeType: sniffed,
    ...(filename ? { originalName: safeFilename(filename) } : {}),
    sha256: sha256(bytes),
    size: bytes.length,
    ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
  };
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Reads dimensions from image headers without decoding pixel data. Unknown
 * WebP variants are left undecoded; the byte limit still bounds their memory
 * use and the browser performs the final decode in its isolated context.
 */
export function inspectImageDimensions(
  bytes: Buffer,
  mimeType: SupportedMimeType,
): ImageDimensions | undefined {
  if (mimeType === 'image/png' && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  if (mimeType === 'image/webp' && bytes.length >= 30) {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    }
    return undefined;
  }

  if (mimeType !== 'image/jpeg' || bytes.length < 4) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    if (marker === undefined) break;
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 1 >= bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return undefined;
}

function safeFilename(filename: string): string {
  const cleaned = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'upload';
}
