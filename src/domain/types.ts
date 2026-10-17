export const SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ImagePayload {
  bytes: Buffer;
  mimeType: SupportedMimeType;
  originalName?: string;
  sha256: string;
  size: number;
}

export interface SearchOptions {
  engine: 'google_lens';
  q?: string;
  hl?: string;
  country?: string;
  type?: string;
}

export interface VisualMatch {
  position: number;
  title: string;
  link: string;
  source: string;
  thumbnail?: string;
  price?: string;
  rating?: number;
}

export interface SearchMetadata {
  id: string;
  status: 'Success' | 'Error';
  json_endpoint: string;
  created_at: string;
  processed_at: string;
  total_time_taken: number;
  cached: boolean;
  source: 'mock' | 'playwright-google-lens';
}

export interface SerpApiResponse {
  search_metadata: SearchMetadata;
  search_parameters: SearchOptions;
  visual_matches: VisualMatch[];
  knowledge_graph?: Array<Record<string, string>>;
  text_results?: Array<{ position: number; text: string; link?: string }>;
  related_content?: Array<{ query: string; link?: string }>;
  error?: { code: string; message: string };
}

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
  failure_kind?: string;
}

export interface JobRecord {
  id: string;
  batchId?: string;
  cacheKey: string;
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
  status_url: string;
}

export interface BatchRecord {
  id: string;
  jobIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PublicBatchRecord {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  created_at: string;
  updated_at: string;
  counts: Record<JobState, number>;
  jobs: PublicJobRecord[];
}
