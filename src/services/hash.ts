import { createHash } from 'node:crypto';

import type { SearchOptions } from '../domain/types.js';

export function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function buildCacheKey(image: Buffer, options: SearchOptions, scope = 'public'): string {
  const optionKey = JSON.stringify([
    options.engine,
    options.q ?? '',
    options.hl ?? '',
    options.country ?? '',
    options.type,
    options.safe ?? '',
    options.autoCrop ?? false,
  ]);
  return `lens:v1:${sha256(scope).slice(0, 24)}:${sha256(image)}:${sha256(optionKey).slice(0, 24)}`;
}
