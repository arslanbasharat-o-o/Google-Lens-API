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
  sourceIcon?: string;
  thumbnail?: string;
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  price?: string;
  extractedPrice?: number;
  currency?: string;
  rating?: number;
}

export interface LensRelatedContent {
  query: string;
  href?: string;
  thumbnail?: string;
}

export interface LensPageSnapshot {
  url: string;
  title: string;
  bodyText: string;
  links: LensDomLink[];
  exactMatches?: LensDomLink[];
  relatedContent?: LensRelatedContent[];
  loading: boolean;
  observedAt: string;
  timings?: Record<string, number>;
}

export interface LensAdapter {
  readonly name: 'mock' | 'playwright-google-lens';
  readonly live: boolean;
  search(input: LensSearchInput): Promise<LensPageSnapshot>;
  start?(): Promise<void>;
  close?(): Promise<void>;
}
