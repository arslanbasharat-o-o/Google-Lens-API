import type { SearchOptions, SupportedMimeType } from '../domain/types.js';

export interface LensSearchInput {
  image: Buffer;
  mimeType: SupportedMimeType;
  originalName?: string;
  options: SearchOptions;
  /** Job identity used by adapters that hand work to an external worker. */
  jobId?: string;
  /** Durable image reference. External adapters must publish this instead of image bytes. */
  imageId?: string;
  /** Monotonic attempt number used to ignore a late result from an older retry. */
  attempt?: number;
  /** Stable ownership token for one job dispatch/attempt. */
  dispatchId?: string;
  /** True when the API admission queue already published the Redis entry. */
  dispatchPublished?: boolean;
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
  readonly name: 'mock' | 'scrapling';
  readonly live: boolean;
  search(input: LensSearchInput): Promise<LensPageSnapshot>;
  start?(): Promise<void>;
  close?(): Promise<void>;
}
