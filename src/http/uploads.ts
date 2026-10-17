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
  return {
    bytes,
    mimeType: sniffed,
    ...(filename ? { originalName: safeFilename(filename) } : {}),
    sha256: sha256(bytes),
    size: bytes.length,
  };
}

function safeFilename(filename: string): string {
  const cleaned = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'upload';
}
