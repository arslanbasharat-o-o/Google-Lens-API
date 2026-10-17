export function getOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Standalone Google Lens API',
      version: '1.0.0',
      description:
        'SerpApi-compatible Google Lens-style image search with bounded jobs, durable image/job storage, and a Redis Streams Scrapling worker contract.',
    },
    servers: [{ url: '/' }],
    paths: {
      '/image': {
        post: {
          summary: 'Upload an image and receive a short-retention image ID',
          security: [{ ApiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['image'],
                  properties: { image: { type: 'string', format: 'binary' } },
                },
              },
            },
          },
          responses: { '201': { description: 'Image ID created' }, '400': { description: 'Invalid image' } },
        },
      },
      '/search': {
        get: { $ref: '#/paths/~1search.json/get' },
        post: { $ref: '#/paths/~1search.json/post' },
      },
      '/search.json': {
        get: {
          summary: 'Search by image ID or public image URL',
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            { name: 'engine', in: 'query', schema: { type: 'string', enum: ['google_lens'], default: 'google_lens' } },
            { name: 'image_id', in: 'query', schema: { type: 'string' } },
            { name: 'url', in: 'query', schema: { type: 'string', format: 'uri' } },
            { name: 'type', in: 'query', schema: { type: 'string', enum: ['all', 'exact_matches', 'visual_matches'] } },
            { name: 'hl', in: 'query', schema: { type: 'string' } },
            { name: 'country', in: 'query', schema: { type: 'string' } },
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'no_cache', in: 'query', schema: { type: 'boolean' } },
            { name: 'async', in: 'query', schema: { type: 'boolean' } },
          ],
          responses: { '200': { description: 'Normalized SerpApi-style result' }, '202': { description: 'Accepted job' }, '400': { description: 'Invalid request' }, '502': { description: 'Typed provider failure' } },
        },
        post: {
          summary: 'Submit one image search',
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            {
              name: 'engine',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['google_lens'], default: 'google_lens' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['image'],
                  properties: { image: { type: 'string', format: 'binary' } },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Normalized SerpApi-style result' },
            '202': { description: 'Accepted job that is still running' },
            '400': { description: 'Invalid upload or parameters' },
            '502': { description: 'Typed browser, challenge, parser, loading, or empty failure' },
          },
        },
      },
      '/v1/lens/search': {
        post: {
          summary: 'Submit one directly uploaded image',
          security: [{ ApiKeyAuth: [] }],
          requestBody: { $ref: '#/components/requestBodies/ImageUpload' },
          responses: { '200': { description: 'Normalized result' }, '202': { description: 'Accepted job' }, '502': { description: 'Provider failure' } },
        },
      },
      '/v1/lens/batch': {
        post: {
          summary: 'Submit a bounded batch of images or image references',
          security: [{ ApiKeyAuth: [] }],
          requestBody: { $ref: '#/components/requestBodies/ImageBatch' },
          responses: { '202': { description: 'Batch accepted' }, '429': { description: 'Queue full' } },
        },
      },
      '/v1/lens/batch/{id}': {
        get: {
          summary: 'Read batch status and child jobs',
          security: [{ ApiKeyAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Batch status' }, '404': { description: 'Unknown batch' } },
        },
      },
      '/v1/jobs/{id}': {
        get: {
          summary: 'Read job status and result',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          security: [{ ApiKeyAuth: [] }],
          responses: { '200': { description: 'Job status' }, '404': { description: 'Unknown job' } },
        },
      },
      '/v1/batches': {
        post: {
          summary: 'Submit a bounded batch of images',
          requestBody: { $ref: '#/components/requestBodies/ImageBatch' },
          responses: { '202': { description: 'Batch accepted' }, '429': { description: 'Queue full' } },
        },
      },
      '/v1/batches/{id}': {
        get: {
          summary: 'Read batch and child job status',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Batch status' }, '404': { description: 'Unknown batch' } },
        },
      },
      '/healthz': { get: { summary: 'Liveness', responses: { '200': { description: 'Healthy' } } } },
      '/health/live': { get: { summary: 'Liveness alias', responses: { '200': { description: 'Healthy' } } } },
      '/readyz': {
        get: {
          summary: 'Readiness',
          responses: { '200': { description: 'Ready' }, '503': { description: 'Not ready' } },
        },
      },
      '/health/ready': { get: { summary: 'Readiness alias', responses: { '200': { description: 'Ready' }, '503': { description: 'Not ready' } } } },
      '/metrics': { get: { summary: 'Prometheus metrics', responses: { '200': { description: 'Metrics' } } } },
    },
    components: {
      requestBodies: {
        ImageUpload: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['image'],
                properties: { image: { type: 'string', format: 'binary' } },
              },
            },
          },
        },
        ImageBatch: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['image'],
                properties: { image: { type: 'array', items: { type: 'string', format: 'binary' } } },
              },
            },
          },
        },
      },
      securitySchemes: {
        ApiKeyAuth: { type: 'http', scheme: 'bearer', description: 'Use Authorization: Bearer <API key> or X-API-Key.' },
      },
      x_lens_worker_contract: {
        version: 'v1',
        stream: 'lens:jobs:v1',
        consumer_group: 'scrapling-workers',
        result_key: 'lens:result:v1:<job_id>',
        message_fields: ['job_id', 'image_id', 'options_json', 'options'],
        image_payload: 'reference-only; bytes remain under IMAGE_STORAGE_DIR',
      },
    },
  };
}
