import type { SearchOptions, SupportedMimeType } from '../domain/types.js';

export interface LensSearchInput {
  image: Buffer;
  mimeType: SupportedMimeType;
  originalName?: string;
  options: SearchOptions;
}

export interface LensDomLink {
  href: string;
  text: string;
  source?: string;
  thumbnail?: string;
  price?: string;
  rating?: number;
}

export interface LensPageSnapshot {
  url: string;
  title: string;
  bodyText: string;
  links: LensDomLink[];
  loading: boolean;
  observedAt: string;
}

export interface LensAdapter {
  readonly name: 'mock' | 'playwright-google-lens';
  readonly live: boolean;
  search(input: LensSearchInput): Promise<LensPageSnapshot>;
}
