export function getOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Standalone Google Lens API',
      version: '1.0.0',
      description:
        'SerpApi-compatible Google Lens-style image search with bounded jobs and an explicit Playwright UI adapter gate.',
    },
    servers: [{ url: '/' }],
    paths: {
      '/search.json': {
        post: {
          summary: 'Submit one image search',
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
      '/v1/jobs/{id}': {
        get: {
          summary: 'Read job status and result',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
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
      '/readyz': {
        get: {
          summary: 'Readiness',
          responses: { '200': { description: 'Ready' }, '503': { description: 'Not ready' } },
        },
      },
      '/metrics': { get: { summary: 'Prometheus metrics', responses: { '200': { description: 'Metrics' } } } },
    },
    components: {
      requestBodies: {
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
    },
  };
}
