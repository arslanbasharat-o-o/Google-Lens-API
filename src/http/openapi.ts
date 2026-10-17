const jsonResponse = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: { 'application/json': { schema } },
});

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const errorResponse = (description: string) => jsonResponse(description, ref('ErrorResponse'));

const commonSearchParameters = [
  { name: 'engine', in: 'query', required: false, schema: { type: 'string', enum: ['google_lens'], default: 'google_lens' } },
  { name: 'type', in: 'query', required: false, schema: { type: 'string', enum: ['all', 'exact_matches', 'visual_matches'], default: 'all' } },
  { name: 'q', in: 'query', required: false, schema: { type: 'string', maxLength: 200 } },
  { name: 'hl', in: 'query', required: false, schema: { type: 'string', maxLength: 200 } },
  { name: 'country', in: 'query', required: false, schema: { type: 'string', maxLength: 200 } },
  { name: 'safe', in: 'query', required: false, schema: { type: 'string', enum: ['active', 'off'] } },
  { name: 'auto_crop', in: 'query', required: false, schema: { type: 'boolean' } },
  { name: 'no_cache', in: 'query', required: false, schema: { type: 'boolean' } },
  { name: 'async', in: 'query', required: false, schema: { type: 'boolean' } },
];

const imageUploadProperties = {
  image: { type: 'string', format: 'binary', description: 'JPEG, PNG, or WebP image bytes.' },
};

const searchUploadProperties = {
  ...imageUploadProperties,
  engine: { type: 'string', enum: ['google_lens'] },
  q: { type: 'string', maxLength: 200 },
  hl: { type: 'string', maxLength: 200 },
  country: { type: 'string', maxLength: 200 },
  type: { type: 'string', enum: ['all', 'exact_matches', 'visual_matches'] },
  safe: { type: 'string', enum: ['active', 'off'] },
  auto_crop: { type: 'boolean' },
  no_cache: { type: 'boolean' },
  async: { type: 'boolean' },
};

const imageUploadBody = {
  required: true,
  content: {
    'multipart/form-data': {
      schema: {
        type: 'object',
        required: ['image'],
        properties: imageUploadProperties,
      },
    },
  },
};

const searchUploadBody = {
  required: true,
  content: {
    'multipart/form-data': {
      schema: {
        type: 'object',
        required: ['image'],
        properties: searchUploadProperties,
      },
    },
  },
};

const batchBody = {
  required: true,
  content: {
    'multipart/form-data': {
      schema: {
        type: 'object',
        description: 'Use repeated image, image_id, or url parts. The request is bounded by MAX_BATCH_SIZE and MAX_BATCH_BYTES.',
        oneOf: [
          { required: ['image'] },
          { required: ['image_id'] },
          { required: ['url'] },
        ],
        properties: {
          image: { type: 'array', items: { type: 'string', format: 'binary' } },
          image_id: { type: 'string', description: 'A comma-separated or repeated retained image ID.' },
          url: { type: 'string', format: 'uri', description: 'A comma-separated or repeated public image URL.' },
          ...Object.fromEntries(Object.entries(searchUploadProperties).filter(([name]) => name !== 'image')),
        },
      },
    },
  },
};

const searchResultResponses = {
  '200': jsonResponse('Completed normalized SerpApi/RMA-compatible response.', ref('SearchResponse')),
  '202': jsonResponse('Accepted job that is still running.', ref('AcceptedSearchResponse')),
  '400': errorResponse('Invalid upload, URL, option, or multipart body.'),
  '401': errorResponse('API key required or invalid.'),
  '404': errorResponse('Unknown or inaccessible retained image.'),
  '413': errorResponse('Image exceeds the configured byte limit.'),
  '429': errorResponse('Rate limit or queue admission limit exceeded.'),
  '502': jsonResponse('Typed provider failure with the failed job.', ref('JobFailureResponse')),
};

const searchGet = {
  summary: 'Search by a retained image ID or a public image URL.',
  description: 'Provide exactly one of image_id or url. URL fetching follows bounded HTTP(S) redirects and rejects private/link-local/metadata destinations before each pinned request.',
  security: [{ ApiKeyAuth: [] }],
  parameters: [
    ...commonSearchParameters,
    { name: 'image_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
    { name: 'url', in: 'query', required: false, schema: { type: 'string', format: 'uri' } },
  ],
  responses: searchResultResponses,
};

const searchPost = {
  summary: 'Submit one image search.',
  security: [{ ApiKeyAuth: [] }],
  parameters: commonSearchParameters,
  requestBody: searchUploadBody,
  responses: searchResultResponses,
};

const batchResponses = {
  '202': jsonResponse('Batch accepted with one independent job per image.', ref('BatchAcceptedResponse')),
  '400': errorResponse('Invalid image, URL, option, or multipart body.'),
  '401': errorResponse('API key required or invalid.'),
  '404': errorResponse('Unknown or inaccessible retained image.'),
  '413': errorResponse('Image exceeds the configured byte limit.'),
  '429': errorResponse('Rate limit or queue admission limit exceeded.'),
};

const batchStatusResponses = {
  '200': jsonResponse('Batch status and child jobs.', ref('PublicBatch')),
  '401': errorResponse('API key required or invalid.'),
  '404': errorResponse('Unknown or inaccessible batch.'),
};

const jobStatusResponses = {
  '200': jsonResponse('Job status, result, or typed error.', ref('PublicJob')),
  '401': errorResponse('API key required or invalid.'),
  '404': errorResponse('Unknown or inaccessible job.'),
};

export function getOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Standalone Google Lens API',
      version: '1.0.0',
      description:
        'SerpApi-compatible Google Lens-style image search with bounded jobs, durable image/job storage, and a Redis Streams Scrapling worker contract. The /upload then GET /search flow is retained for RMA compatibility. The live Scrapling adapter rejects q, hl, country, safe, and auto_crop with validation_error because it cannot apply them; the mock adapter accepts them for offline contract tests.',
    },
    servers: [{ url: '/' }],
    paths: {
      '/': {
        get: {
          summary: 'Service metadata.',
          responses: { '200': { description: 'Service metadata and OpenAPI URL.', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/image': {
        post: {
          summary: 'Upload an image and receive a short-retention image ID.',
          security: [{ ApiKeyAuth: [] }],
          requestBody: imageUploadBody,
          responses: {
            '200': jsonResponse('Idempotent upload already exists.', ref('ImageUploadResponse')),
            '201': jsonResponse('Image ID created.', ref('ImageUploadResponse')),
            '400': errorResponse('Invalid image or multipart body.'),
            '401': errorResponse('API key required or invalid.'),
            '413': errorResponse('Image exceeds the configured byte limit.'),
            '429': errorResponse('Rate limit exceeded.'),
          },
        },
      },
      '/upload': { post: { $ref: '#/paths/~1image/post' } },
      '/search': {
        get: { $ref: '#/paths/~1search.json/get' },
        post: { $ref: '#/paths/~1search.json/post' },
      },
      '/search.json': {
        get: searchGet,
        post: searchPost,
      },
      '/v1/search': { post: { $ref: '#/paths/~1search.json/post' } },
      '/v1/lens/search': { post: { $ref: '#/paths/~1search.json/post' } },
      '/v1/lens/batch': {
        post: {
          summary: 'Submit a bounded batch of images or retained image/URL references.',
          security: [{ ApiKeyAuth: [] }],
          parameters: commonSearchParameters,
          requestBody: batchBody,
          responses: batchResponses,
        },
      },
      '/v1/batches': { post: { $ref: '#/paths/~1v1~1lens~1batch/post' } },
      '/v1/lens/batch/{id}': {
        get: {
          summary: 'Read batch status and child jobs.',
          security: [{ ApiKeyAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: batchStatusResponses,
        },
      },
      '/v1/batches/{id}': { get: { $ref: '#/paths/~1v1~1lens~1batch~1{id}/get' } },
      '/batches/{id}': { get: { $ref: '#/paths/~1v1~1lens~1batch~1{id}/get' } },
      '/v1/jobs/{id}': {
        get: {
          summary: 'Read job status and result.',
          security: [{ ApiKeyAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: jobStatusResponses,
        },
        delete: {
          summary: 'Cancel a queued or running job.',
          security: [{ ApiKeyAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '202': jsonResponse('Cancellation accepted or job was already terminal.', ref('PublicJob')),
            '401': errorResponse('API key required or invalid.'),
            '404': errorResponse('Unknown or inaccessible job.'),
          },
        },
      },
      '/jobs/{id}': { get: { $ref: '#/paths/~1v1~1jobs~1{id}/get' } },
      '/v1/lens/jobs/{id}': {
        get: { $ref: '#/paths/~1v1~1jobs~1{id}/get' },
        delete: { $ref: '#/paths/~1v1~1jobs~1{id}/delete' },
      },
      '/healthz': { get: { summary: 'Liveness.', responses: { '200': jsonResponse('Healthy.', ref('HealthResponse')) } } },
      '/health/live': { get: { summary: 'Liveness alias.', responses: { '200': jsonResponse('Healthy.', ref('HealthResponse')) } } },
      '/readyz': {
        get: {
          summary: 'Readiness.',
          responses: {
            '200': jsonResponse('Ready.', ref('ReadinessResponse')),
            '503': jsonResponse('Not ready.', ref('ReadinessResponse')),
          },
        },
      },
      '/health/ready': { get: { $ref: '#/paths/~1readyz/get' } },
      '/metrics': {
        get: {
          summary: 'Prometheus metrics.',
          security: [{ ApiKeyAuth: [] }],
          responses: {
            '200': { description: 'Prometheus text metrics.', content: { 'text/plain': { schema: { type: 'string' } } } },
            '401': errorResponse('API key required or invalid.'),
          },
        },
      },
      '/openapi.json': { get: { summary: 'OpenAPI 3.0 document.', responses: { '200': { description: 'This document.' } } } },
    },
    components: {
      schemas: {
        ImageUploadResponse: {
          type: 'object',
          required: ['image_id', 'sha256', 'mime_type', 'size', 'expires_at'],
          properties: {
            image_id: { type: 'string', format: 'uuid' },
            sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            mime_type: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] },
            size: { type: 'integer', minimum: 1 },
            expires_at: { type: 'string', format: 'date-time' },
          },
        },
        SearchOptions: {
          type: 'object',
          required: ['engine', 'type'],
          properties: {
            engine: { type: 'string', enum: ['google_lens'] },
            q: { type: 'string' },
            hl: { type: 'string' },
            country: { type: 'string' },
            type: { type: 'string', enum: ['all', 'exact_matches', 'visual_matches'] },
            safe: { type: 'string', enum: ['active', 'off'] },
            autoCrop: { type: 'boolean', description: 'Only emitted when the selected adapter applies this option.' },
            noCache: { type: 'boolean' },
            async: { type: 'boolean' },
          },
        },
        VisualMatch: {
          type: 'object',
          required: ['position', 'title', 'link', 'source'],
          properties: {
            position: { type: 'integer', minimum: 1 },
            title: { type: 'string' },
            link: { type: 'string', format: 'uri' },
            source: { type: 'string' },
            source_icon: { type: 'string', format: 'uri' },
            thumbnail: { type: 'string', format: 'uri' },
            image: { type: 'string', format: 'uri' },
            image_width: { type: 'integer', minimum: 1 },
            image_height: { type: 'integer', minimum: 1 },
            price: { type: 'string' },
            extracted_price: { type: 'number' },
            currency: { type: 'string' },
            rating: { type: 'number' },
          },
        },
        RelatedContent: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string' },
            link: { type: 'string', format: 'uri' },
            thumbnail: { type: 'string', format: 'uri' },
          },
        },
        SearchMetadata: {
          type: 'object',
          required: ['id', 'status', 'json_endpoint', 'created_at', 'processed_at', 'total_time_taken', 'cached', 'source'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['Success', 'Error'] },
            json_endpoint: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
            processed_at: { type: 'string', format: 'date-time' },
            total_time_taken: { type: 'number', minimum: 0 },
            cached: { type: 'boolean' },
            source: { type: 'string', enum: ['mock', 'scrapling'] },
          },
        },
        SearchResponse: {
          type: 'object',
          required: ['search_metadata', 'search_parameters', 'visual_matches'],
          properties: {
            search_metadata: ref('SearchMetadata'),
            search_parameters: ref('SearchOptions'),
            visual_matches: { type: 'array', items: ref('VisualMatch') },
            exact_matches: { type: 'array', items: ref('VisualMatch') },
            related_content: { type: 'array', items: ref('RelatedContent') },
            knowledge_graph: { type: 'array', items: { type: 'object', additionalProperties: { type: 'string' } } },
            text_results: { type: 'array', items: { type: 'object', required: ['position', 'text'], properties: { position: { type: 'integer' }, text: { type: 'string' }, link: { type: 'string', format: 'uri' } } } },
            error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } },
          },
        },
        AcceptedSearchResponse: {
          type: 'object',
          required: ['job_id', 'status', 'status_url'],
          properties: {
            job_id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['queued', 'running'] },
            status_url: { type: 'string' },
          },
        },
        JobError: {
          type: 'object',
          required: ['code', 'message', 'retryable'],
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            retryable: { type: 'boolean' },
            failure_kind: { type: 'string' },
            dead_letter: { type: 'boolean' },
            details: { type: 'object', additionalProperties: true },
          },
        },
        PublicJob: {
          type: 'object',
          required: ['id', 'status', 'attempts', 'created_at', 'updated_at', 'cache_key', 'status_url'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            batch_id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
            attempts: { type: 'integer', minimum: 0 },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
            started_at: { type: 'string', format: 'date-time' },
            finished_at: { type: 'string', format: 'date-time' },
            cancelled_at: { type: 'string', format: 'date-time' },
            cache_key: { type: 'string' },
            result: ref('SearchResponse'),
            error: ref('JobError'),
            status_url: { type: 'string' },
          },
        },
        JobFailureResponse: {
          type: 'object',
          required: ['error', 'job'],
          properties: { error: ref('JobError'), job: ref('PublicJob') },
        },
        Counts: {
          type: 'object',
          required: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
          properties: {
            queued: { type: 'integer', minimum: 0 },
            running: { type: 'integer', minimum: 0 },
            succeeded: { type: 'integer', minimum: 0 },
            failed: { type: 'integer', minimum: 0 },
            cancelled: { type: 'integer', minimum: 0 },
          },
        },
        BatchAcceptedResponse: {
          type: 'object',
          required: ['batch_id', 'status', 'status_url', 'counts', 'jobs'],
          properties: {
            batch_id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['queued', 'running', 'retry_pending', 'completed', 'completed_with_errors', 'failed', 'cancelled'] },
            status_url: { type: 'string' },
            counts: ref('Counts'),
            jobs: { type: 'array', items: ref('PublicJob') },
          },
        },
        PublicBatch: {
          type: 'object',
          required: ['id', 'status', 'created_at', 'updated_at', 'counts', 'jobs'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['queued', 'running', 'retry_pending', 'completed', 'completed_with_errors', 'failed', 'cancelled'] },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
            counts: ref('Counts'),
            jobs: { type: 'array', items: ref('PublicJob') },
          },
        },
        ErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: { error: ref('JobError'), job: ref('PublicJob') },
        },
        HealthResponse: {
          type: 'object',
          required: ['status', 'service', 'adapter', 'queue_backend', 'live_automation_enabled', 'queue_depth', 'running_workers', 'retained_images', 'uptime_seconds'],
          properties: {
            status: { type: 'string', enum: ['ok'] },
            service: { type: 'string' },
            adapter: { type: 'string', enum: ['mock', 'scrapling'] },
            queue_backend: { type: 'string', enum: ['memory', 'redis'] },
            live_automation_enabled: { type: 'boolean' },
            queue_depth: { type: 'integer', minimum: 0 },
            running_workers: { type: 'integer', minimum: 0 },
            retained_images: { type: 'integer', minimum: 0 },
            uptime_seconds: { type: 'integer', minimum: 0 },
          },
        },
        ReadinessResponse: {
          type: 'object',
          required: ['status', 'adapter', 'queue_backend', 'live_automation_enabled', 'auth_configured', 'worker_ready'],
          properties: {
            status: { type: 'string', enum: ['ready', 'not_ready'] },
            adapter: { type: 'string', enum: ['mock', 'scrapling'] },
            queue_backend: { type: 'string', enum: ['memory', 'redis'] },
            live_automation_enabled: { type: 'boolean' },
            auth_configured: { type: 'boolean' },
            worker_ready: { type: 'boolean' },
            reason: { type: 'string' },
          },
        },
      },
      requestBodies: {
        ImageUpload: imageUploadBody,
        ImageBatch: batchBody,
      },
      securitySchemes: {
        ApiKeyAuth: { type: 'http', scheme: 'bearer', description: 'Use Authorization: Bearer <API key> or X-API-Key.' },
      },
      x_lens_worker_contract: {
        version: 'v1',
        stream: 'lens:jobs:v1',
        consumer_group: 'scrapling-workers',
        result_key: 'lens:result:v1:<job_id>:<attempt>',
         message_fields: ['job_id', 'attempt', 'dispatch_id', 'image_id', 'options_json', 'options'],
        image_payload: 'reference-only; bytes remain under IMAGE_STORAGE_DIR',
      },
      x_live_unsupported_search_options: ['q', 'hl', 'country', 'safe', 'auto_crop'],
    },
  };
}
