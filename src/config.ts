export type AdapterName = 'mock' | 'scrapling';
export type QueueBackend = 'memory' | 'redis';
export type ImageStorageBackend = 'memory' | 'file';
export type ScraplingWorkerMode = 'disabled' | 'fixture' | 'live';

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  logLevel: string;
  maxImageBytes: number;
  maxImagePixels: number;
  maxImageDimension: number;
  maxBatchSize: number;
  maxBatchBytes: number;
  maxQueueSize: number;
  workerConcurrency: number;
  searchSyncWaitMs: number;
  jobRetentionMs: number;
  maxJobRecords: number;
  imageRetentionMs: number;
  maxImageRecords: number;
  imageStorageDir: string;
  imageStorageBackend: ImageStorageBackend;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  maxAttempts: number;
  retryBaseMs: number;
  remoteFetchTimeoutMs: number;
  remoteFetchMaxBytes: number;
  remoteFetchMaxRedirects: number;
  apiKeys: string[];
  authRequired: boolean;
  allowQueryApiKey: boolean;
  rateLimitPerMinute: number;
  rateLimitStoreMax: number;
  queueBackend: QueueBackend;
  redisUrl?: string;
  adapter: AdapterName;
  scraplingResultTimeoutMs: number;
  scraplingPollIntervalMs: number;
  scraplingWorkerMode: ScraplingWorkerMode;
  scraplingHeartbeatMaxAgeMs: number;
  liveAutomationEnabled: boolean;
  liveAutomationAuthorized: boolean;
}

function readPositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum = 1,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true or false`);
}

function readList(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const adapterRaw = (env.LENS_ADAPTER ?? 'mock').trim().toLowerCase();
  if (adapterRaw !== 'mock' && adapterRaw !== 'scrapling') {
    throw new Error('LENS_ADAPTER must be mock or scrapling; direct Playwright automation was retired');
  }
  if (
    nodeEnv === 'production' &&
    adapterRaw === 'mock' &&
    env.ALLOW_MOCK_ADAPTER_IN_PRODUCTION !== 'true'
  ) {
    throw new Error('The mock adapter is disabled in production; configure LENS_ADAPTER=scrapling.');
  }

  const queueBackendRaw = env.QUEUE_BACKEND ?? 'memory';
  if (queueBackendRaw !== 'memory' && queueBackendRaw !== 'redis') {
    throw new Error('QUEUE_BACKEND must be memory or redis');
  }
  const imageStorageBackendRaw = env.IMAGE_STORAGE_BACKEND ?? (nodeEnv === 'production' ? 'file' : 'memory');
  if (imageStorageBackendRaw !== 'memory' && imageStorageBackendRaw !== 'file') {
    throw new Error('IMAGE_STORAGE_BACKEND must be memory or file');
  }
  const scraplingWorkerModeRaw = env.SCRAPLING_WORKER_MODE ?? 'disabled';
  if (!['disabled', 'fixture', 'live'].includes(scraplingWorkerModeRaw)) {
    throw new Error('SCRAPLING_WORKER_MODE must be disabled, fixture, or live');
  }

  if (adapterRaw === 'scrapling' && scraplingWorkerModeRaw === 'disabled') {
    throw new Error('LENS_ADAPTER=scrapling requires SCRAPLING_WORKER_MODE=fixture or live.');
  }
  if (adapterRaw !== 'scrapling' && scraplingWorkerModeRaw !== 'disabled') {
    throw new Error('SCRAPLING_WORKER_MODE=fixture/live requires LENS_ADAPTER=scrapling.');
  }
  if (adapterRaw === 'scrapling' && imageStorageBackendRaw !== 'file') {
    throw new Error('LENS_ADAPTER=scrapling requires IMAGE_STORAGE_BACKEND=file for shared worker images.');
  }

  if (queueBackendRaw === 'redis' && !env.REDIS_URL?.trim()) {
    throw new Error('REDIS_URL is required when QUEUE_BACKEND=redis');
  }
  if (adapterRaw === 'scrapling' && !env.REDIS_URL?.trim()) {
    throw new Error('REDIS_URL is required when LENS_ADAPTER=scrapling');
  }

  const liveAutomationAuthorized =
    env.GOOGLE_LENS_LIVE_AUTHORIZED === 'I_UNDERSTAND_AND_AUTHORIZE';
  const liveAutomationRequested = readBoolean(env, 'GOOGLE_LENS_LIVE_ENABLED', false);
  const liveAutomationEnabled = liveAutomationRequested && liveAutomationAuthorized;
  if (scraplingWorkerModeRaw === 'live' && !liveAutomationEnabled) {
    throw new Error(
      'SCRAPLING_WORKER_MODE=live requires GOOGLE_LENS_LIVE_ENABLED=true and '
      + 'GOOGLE_LENS_LIVE_AUTHORIZED=I_UNDERSTAND_AND_AUTHORIZE',
    );
  }
  if (scraplingWorkerModeRaw !== 'live' && (liveAutomationRequested || liveAutomationAuthorized)) {
    throw new Error('Google Lens live authorization variables require SCRAPLING_WORKER_MODE=live.');
  }

  const apiKeys = readList(env, 'API_KEYS');
  const authRequired = readBoolean(env, 'API_AUTH_REQUIRED', nodeEnv === 'production');
  if (nodeEnv === 'production' && !authRequired) {
    throw new Error('API_AUTH_REQUIRED must remain true in production deployments.');
  }
  if (authRequired && apiKeys.length === 0) {
    throw new Error('API_KEYS must contain at least one secret when API_AUTH_REQUIRED=true.');
  }

  return {
    nodeEnv,
    host: env.HOST ?? '127.0.0.1',
    port: readPositiveInt(env, 'PORT', 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    maxImageBytes: readPositiveInt(env, 'MAX_IMAGE_BYTES', 10 * 1024 * 1024),
    maxImagePixels: readPositiveInt(env, 'MAX_IMAGE_PIXELS', 40_000_000),
    maxImageDimension: readPositiveInt(env, 'MAX_IMAGE_DIMENSION', 10_000),
    maxBatchSize: readPositiveInt(env, 'MAX_BATCH_SIZE', 100),
    maxBatchBytes: readPositiveInt(env, 'MAX_BATCH_BYTES', 50 * 1024 * 1024),
    maxQueueSize: readPositiveInt(env, 'MAX_QUEUE_SIZE', 500),
    workerConcurrency: readPositiveInt(env, 'WORKER_CONCURRENCY', 2),
    searchSyncWaitMs: readPositiveInt(env, 'SEARCH_SYNC_WAIT_MS', 1000, 0),
    jobRetentionMs: readPositiveInt(env, 'JOB_RETENTION_MS', 60 * 60 * 1000),
    maxJobRecords: readPositiveInt(env, 'MAX_JOB_RECORDS', 5000),
    imageRetentionMs: readPositiveInt(env, 'IMAGE_RETENTION_MS', 15 * 60 * 1000),
    maxImageRecords: readPositiveInt(env, 'MAX_IMAGE_RECORDS', 1000),
    imageStorageDir: env.IMAGE_STORAGE_DIR?.trim() || './data/images',
    imageStorageBackend: imageStorageBackendRaw,
    cacheTtlMs: readPositiveInt(env, 'CACHE_TTL_MS', 5 * 60 * 1000),
    cacheMaxEntries: readPositiveInt(env, 'CACHE_MAX_ENTRIES', 500),
    maxAttempts: readPositiveInt(env, 'MAX_ATTEMPTS', 2),
    retryBaseMs: readPositiveInt(env, 'RETRY_BASE_MS', 250),
    remoteFetchTimeoutMs: readPositiveInt(env, 'REMOTE_FETCH_TIMEOUT_MS', 10_000),
    remoteFetchMaxBytes: readPositiveInt(env, 'REMOTE_FETCH_MAX_BYTES', 10 * 1024 * 1024),
    remoteFetchMaxRedirects: readPositiveInt(env, 'REMOTE_FETCH_MAX_REDIRECTS', 3, 0),
    apiKeys,
    authRequired,
    allowQueryApiKey: readBoolean(env, 'ALLOW_QUERY_API_KEY', false),
    rateLimitPerMinute: readPositiveInt(env, 'RATE_LIMIT_PER_MINUTE', 120),
    rateLimitStoreMax: readPositiveInt(env, 'RATE_LIMIT_STORE_MAX', 10_000),
    queueBackend: queueBackendRaw,
    ...(env.REDIS_URL?.trim() ? { redisUrl: env.REDIS_URL.trim() } : {}),
    adapter: adapterRaw,
    scraplingResultTimeoutMs: readPositiveInt(env, 'SCRAPLING_RESULT_TIMEOUT_MS', 30_000),
    scraplingPollIntervalMs: readPositiveInt(env, 'SCRAPLING_POLL_INTERVAL_MS', 250),
    scraplingWorkerMode: scraplingWorkerModeRaw as ScraplingWorkerMode,
    scraplingHeartbeatMaxAgeMs: readPositiveInt(env, 'SCRAPLING_HEARTBEAT_MAX_AGE_MS', 60_000),
    liveAutomationEnabled,
    liveAutomationAuthorized,
  };
}
