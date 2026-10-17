# Standalone Google Lens API

A production-oriented TypeScript/Node service that exposes a small
SerpApi-compatible Google Lens-style API. It is designed to be reproducible
from a clean checkout and to test entirely offline. The default adapter is a
local deterministic mock; no live Google query is made by the test suite or by
the default configuration.

## Requirements

- Node.js `20.19.0` (the version is pinned in `.nvmrc`)
- npm 10+
- Docker 24+ is optional for the container path

The dependency graph is pinned in `package-lock.json`. Install dependencies
inside this project only:

```sh
npm ci
```

## Setup and run

```sh
cp .env.example .env
npm run build
npm start
```

The server listens on `127.0.0.1:3000` by default. Set `HOST=0.0.0.0` for a
container or a managed runtime. `LENS_ADAPTER=mock` is the safe default.

## Offline checks

The single reproducible check command is:

```sh
make check
```

It runs TypeScript typechecking, the Vitest suite, and a production build. The
tests use `MockLensAdapter` and local HTML fixtures under `test/fixtures`; they
do not launch Playwright or access the network.

Individual commands:

```sh
npm test             # 12+ offline behavior tests
npm run typecheck
npm run build
```

## HTTP API

### One image

`POST /search.json` and `POST /v1/search` accept a multipart field named
`image`. The upload must be a JPEG, PNG, or WebP whose magic bytes match its
declared MIME type. `engine=google_lens` is the only supported engine.

```sh
curl -F image=@./image.png \
  'http://127.0.0.1:3000/search.json?engine=google_lens&hl=en'
```

Fast jobs return HTTP 200 with a normalized SerpApi-style response:

```json
{
  "search_metadata": {
    "id": "job-id",
    "status": "Success",
    "json_endpoint": "/v1/jobs/job-id",
    "cached": false,
    "source": "mock"
  },
  "search_parameters": { "engine": "google_lens", "hl": "en" },
  "visual_matches": [
    { "position": 1, "title": "Blue chair product listing", "link": "https://example.com/products/blue-chair", "source": "example.com" }
  ]
}
```

If the bounded queue or worker takes longer than `SEARCH_SYNC_WAIT_MS`, the
endpoint returns HTTP 202 with `job_id` and `status_url`. Poll
`GET /v1/jobs/:id` (also available at `/jobs/:id`) for `queued`, `running`,
`succeeded`, or `failed` state and the result/error payload.

### Batches

`POST /v1/batches` accepts up to `MAX_BATCH_SIZE` repeated `image` parts and
returns a batch ID. Poll `GET /v1/batches/:id` for aggregate counts and child
jobs. Batch uploads share the same upload size and MIME checks.

### Operations

- `GET /healthz` — liveness and queue/worker information
- `GET /readyz` — readiness; a selected live adapter without both gates is not ready
- `GET /metrics` — Prometheus text metrics
- `GET /openapi.json` — OpenAPI 3.0 document

## Live Playwright adapter

The real adapter is selected with `LENS_ADAPTER=playwright`. It is still
refused unless both gates below are explicitly set:

```sh
LENS_ADAPTER=playwright \
GOOGLE_LENS_LIVE_ENABLED=true \
GOOGLE_LENS_LIVE_AUTHORIZED=I_UNDERSTAND_AND_AUTHORIZE \
npm start
```

It uses Playwright to navigate to `LENS_TARGET_URL` (default
`https://lens.google.com/`), upload bytes through an `input[type=file]`, and
read observable DOM state. Loading, challenge, empty, parser, and browser
failures are converted into typed job errors. The service intentionally does
not solve challenges or bypass access controls. Do not enable this mode in
the offline test workflow.

## Docker and deployment

The multi-stage Dockerfile pins Node 20.19.0, installs the locked dependency
graph, installs Chromium and its Debian runtime packages for the optional
Playwright path, and runs as the unprivileged `node` user. The image defaults
to the mock adapter and live automation disabled.

```sh
docker build -t standalone-google-lens-api:local .
docker run --rm -p 3000:3000 standalone-google-lens-api:local
```

Or use the local compose configuration:

```sh
docker compose up --build
```

For a deployment, provide environment variables through the platform secret
store or environment configuration. No secret, API key, cookie, or token is
stored in this repository. The current job queue and cache are in-memory;
restart-safe distributed execution should provide a queue implementing the
`JobQueue` contract (the `BullMqEnqueueBoundary` documents the compatible
producer payload).
