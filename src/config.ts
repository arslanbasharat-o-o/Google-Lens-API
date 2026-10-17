export type AdapterName = 'mock' | 'playwright';
export type QueueBackend = 'memory' | 'redis';

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  logLevel: string;
  maxImageBytes: number;
  maxImagePixels: number;
  maxImageDimension: number;
  maxBatchSize: number;
  maxQueueSize: number;
  workerConcurrency: number;
  searchSyncWaitMs: number;
  jobRetentionMs: number;
  maxJobRecords: number;
  imageRetentionMs: number;
  maxImageRecords: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  maxAttempts: number;
  retryBaseMs: number;
  remoteFetchTimeoutMs: number;
  remoteFetchMaxBytes: number;
  remoteFetchMaxRedirects: number;
  apiKeys: string[];
  authRequired: boolean;
  rateLimitPerMinute: number;
  rateLimitStoreMax: number;
  queueBackend: QueueBackend;
  redisUrl?: string;
  adapter: AdapterName;
  lensTargetUrl: string;
  playwrightHeadless: boolean;
  playwrightTimeoutMs: number;
  browserMinProcesses: number;
  browserMaxProcesses: number;
  browserContextsPerProcess: number;
  browserRecycleJobs: number;
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
  const adapterRaw = env.LENS_ADAPTER ?? 'mock';
  if (adapterRaw !== 'mock' && adapterRaw !== 'playwright') {
    throw new Error('LENS_ADAPTER must be mock or playwright');
  }
  if (
    nodeEnv === 'production' &&
    adapterRaw === 'mock' &&
    env.ALLOW_MOCK_ADAPTER_IN_PRODUCTION !== 'true'
  ) {
    throw new Error('The mock adapter is disabled in production; configure LENS_ADAPTER=playwright.');
  }

  const queueBackendRaw = env.QUEUE_BACKEND ?? 'memory';
  if (queueBackendRaw !== 'memory' && queueBackendRaw !== 'redis') {
    throw new Error('QUEUE_BACKEND must be memory or redis');
  }

  const browserMaxProcesses = readPositiveInt(env, 'BROWSER_MAX_PROCESSES', 1);
  const browserMinProcesses = readPositiveInt(env, 'BROWSER_MIN_PROCESSES', 1);
  if (browserMinProcesses > browserMaxProcesses) {
    throw new Error('BROWSER_MIN_PROCESSES cannot exceed BROWSER_MAX_PROCESSES');
  }
  if (queueBackendRaw === 'redis' && !env.REDIS_URL?.trim()) {
    throw new Error('REDIS_URL is required when QUEUE_BACKEND=redis');
  }

  const liveAutomationAuthorized =
    env.GOOGLE_LENS_LIVE_AUTHORIZED === 'I_UNDERSTAND_AND_AUTHORIZE';
  const liveAutomationEnabled =
    readBoolean(env, 'GOOGLE_LENS_LIVE_ENABLED', false) && liveAutomationAuthorized;

  return {
    nodeEnv,
    host: env.HOST ?? '127.0.0.1',
    port: readPositiveInt(env, 'PORT', 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    maxImageBytes: readPositiveInt(env, 'MAX_IMAGE_BYTES', 10 * 1024 * 1024),
    maxImagePixels: readPositiveInt(env, 'MAX_IMAGE_PIXELS', 40_000_000),
    maxImageDimension: readPositiveInt(env, 'MAX_IMAGE_DIMENSION', 10_000),
    maxBatchSize: readPositiveInt(env, 'MAX_BATCH_SIZE', 100),
    maxQueueSize: readPositiveInt(env, 'MAX_QUEUE_SIZE', 500),
    workerConcurrency: readPositiveInt(env, 'WORKER_CONCURRENCY', 2),
    searchSyncWaitMs: readPositiveInt(env, 'SEARCH_SYNC_WAIT_MS', 1000, 0),
    jobRetentionMs: readPositiveInt(env, 'JOB_RETENTION_MS', 60 * 60 * 1000),
    maxJobRecords: readPositiveInt(env, 'MAX_JOB_RECORDS', 5000),
    imageRetentionMs: readPositiveInt(env, 'IMAGE_RETENTION_MS', 15 * 60 * 1000),
    maxImageRecords: readPositiveInt(env, 'MAX_IMAGE_RECORDS', 1000),
    cacheTtlMs: readPositiveInt(env, 'CACHE_TTL_MS', 5 * 60 * 1000),
    cacheMaxEntries: readPositiveInt(env, 'CACHE_MAX_ENTRIES', 500),
    maxAttempts: readPositiveInt(env, 'MAX_ATTEMPTS', 2),
    retryBaseMs: readPositiveInt(env, 'RETRY_BASE_MS', 250),
    remoteFetchTimeoutMs: readPositiveInt(env, 'REMOTE_FETCH_TIMEOUT_MS', 10_000),
    remoteFetchMaxBytes: readPositiveInt(env, 'REMOTE_FETCH_MAX_BYTES', 10 * 1024 * 1024),
    remoteFetchMaxRedirects: readPositiveInt(env, 'REMOTE_FETCH_MAX_REDIRECTS', 3, 0),
    apiKeys: readList(env, 'API_KEYS'),
    authRequired: readBoolean(env, 'API_AUTH_REQUIRED', nodeEnv === 'production'),
    rateLimitPerMinute: readPositiveInt(env, 'RATE_LIMIT_PER_MINUTE', 120),
    rateLimitStoreMax: readPositiveInt(env, 'RATE_LIMIT_STORE_MAX', 10_000),
    queueBackend: queueBackendRaw,
    ...(env.REDIS_URL?.trim() ? { redisUrl: env.REDIS_URL.trim() } : {}),
    adapter: adapterRaw,
    lensTargetUrl: env.LENS_TARGET_URL ?? 'https://lens.google.com/',
    playwrightHeadless: readBoolean(env, 'PLAYWRIGHT_HEADLESS', true),
    playwrightTimeoutMs: readPositiveInt(env, 'PLAYWRIGHT_TIMEOUT_MS', 15_000),
    browserMinProcesses,
    browserMaxProcesses,
    browserContextsPerProcess: readPositiveInt(env, 'BROWSER_CONTEXTS_PER_PROCESS', 4),
    browserRecycleJobs: readPositiveInt(env, 'BROWSER_RECYCLE_JOBS', 100),
    liveAutomationEnabled,
    liveAutomationAuthorized,
  };
}
