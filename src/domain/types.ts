export const SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ImagePayload {
  bytes: Buffer;
  mimeType: SupportedMimeType;
  originalName?: string;
  sha256: string;
  size: number;
  width?: number;
  height?: number;
}

export interface SearchOptions {
  engine: 'google_lens';
  q?: string;
  hl?: string;
  country?: string;
  type: 'all' | 'exact_matches' | 'visual_matches';
  safe?: 'active' | 'off';
  autoCrop?: boolean;
  noCache?: boolean;
  async?: boolean;
}

export interface VisualMatch {
  position: number;
  title: string;
  link: string;
  source: string;
  source_icon?: string;
  thumbnail?: string;
  image?: string;
  image_width?: number;
  image_height?: number;
  price?: string;
  extracted_price?: number;
  currency?: string;
  rating?: number;
}

export interface RelatedContent {
  query: string;
  link?: string;
  thumbnail?: string;
}

export interface SearchMetadata {
  id: string;
  status: 'Success' | 'Error';
  json_endpoint: string;
  created_at: string;
  processed_at: string;
  total_time_taken: number;
  cached: boolean;
  source: 'mock' | 'scrapling';
}

export interface SerpApiResponse {
  search_metadata: SearchMetadata;
  search_parameters: SearchOptions;
  visual_matches: VisualMatch[];
  exact_matches?: VisualMatch[];
  related_content?: RelatedContent[];
  knowledge_graph?: Array<Record<string, string>>;
  text_results?: Array<{ position: number; text: string; link?: string }>;
  error?: { code: string; message: string };
}

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
  failure_kind?: string;
  dead_letter?: boolean;
}

export interface JobRecord {
  id: string;
  batchId?: string;
  principal?: string;
  cacheKey: string;
  /** Durable reference used by external workers; bytes remain an internal fallback. */
  imageId?: string;
  image: ImagePayload;
  options: SearchOptions;
  state: JobState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: SerpApiResponse;
  error?: JobError;
  cancelledAt?: string;
}

export interface PublicJobRecord {
  id: string;
  batch_id?: string;
  status: JobState;
  attempts: number;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  cache_key: string;
  result?: SerpApiResponse;
  error?: JobError;
  cancelled_at?: string;
  status_url: string;
}

export interface BatchRecord {
  id: string;
  principal?: string;
  jobIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PublicBatchRecord {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled' | 'retry_pending';
  created_at: string;
  updated_at: string;
  counts: Record<JobState, number>;
  jobs: PublicJobRecord[];
}
