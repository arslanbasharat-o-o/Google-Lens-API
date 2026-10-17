export type AdapterName = 'mock' | 'playwright';

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  logLevel: string;
  maxImageBytes: number;
  maxBatchSize: number;
  maxQueueSize: number;
  workerConcurrency: number;
  searchSyncWaitMs: number;
  jobRetentionMs: number;
  maxJobRecords: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  adapter: AdapterName;
  lensTargetUrl: string;
  playwrightHeadless: boolean;
  playwrightTimeoutMs: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const adapterRaw = env.LENS_ADAPTER ?? 'mock';
  if (adapterRaw !== 'mock' && adapterRaw !== 'playwright') {
    throw new Error('LENS_ADAPTER must be mock or playwright');
  }

  const liveAutomationAuthorized =
    env.GOOGLE_LENS_LIVE_AUTHORIZED === 'I_UNDERSTAND_AND_AUTHORIZE';
  const liveAutomationEnabled =
    readBoolean(env, 'GOOGLE_LENS_LIVE_ENABLED', false) && liveAutomationAuthorized;

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    host: env.HOST ?? '127.0.0.1',
    port: readPositiveInt(env, 'PORT', 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    maxImageBytes: readPositiveInt(env, 'MAX_IMAGE_BYTES', 10 * 1024 * 1024),
    maxBatchSize: readPositiveInt(env, 'MAX_BATCH_SIZE', 10),
    maxQueueSize: readPositiveInt(env, 'MAX_QUEUE_SIZE', 100),
    workerConcurrency: readPositiveInt(env, 'WORKER_CONCURRENCY', 2),
    searchSyncWaitMs: readPositiveInt(env, 'SEARCH_SYNC_WAIT_MS', 1000, 0),
    jobRetentionMs: readPositiveInt(env, 'JOB_RETENTION_MS', 60 * 60 * 1000),
    maxJobRecords: readPositiveInt(env, 'MAX_JOB_RECORDS', 1000),
    cacheTtlMs: readPositiveInt(env, 'CACHE_TTL_MS', 5 * 60 * 1000),
    cacheMaxEntries: readPositiveInt(env, 'CACHE_MAX_ENTRIES', 500),
    adapter: adapterRaw,
    lensTargetUrl: env.LENS_TARGET_URL ?? 'https://lens.google.com/',
    playwrightHeadless: readBoolean(env, 'PLAYWRIGHT_HEADLESS', true),
    playwrightTimeoutMs: readPositiveInt(env, 'PLAYWRIGHT_TIMEOUT_MS', 15_000),
    liveAutomationEnabled,
    liveAutomationAuthorized,
  };
}
