# Standalone Google Lens API

A production-oriented TypeScript/Node service that exposes a small
SerpApi-compatible Google Lens-style API. It is designed to be reproducible
from a clean checkout and to test entirely offline. Development and tests use a
local deterministic mock; production uses the Redis Streams Scrapling worker
contract and never sends image bytes through Redis.

## Requirements

- Node.js `22.14.0` (the version is pinned in `.nvmrc`)
- npm 10+
- Python `3.12.4` and `uv` (pinned in `.python-version` and `uv.lock`)
- Docker 24+ is optional for the container path

The dependency graph is pinned in `package-lock.json`. Install dependencies
inside this project only:

```sh
npm ci
uv sync --locked --extra dev
```

## Setup and run

```sh
cp .env.example .env
npm run build
npm start
```

The server listens on `127.0.0.1:3000` by default. Set `HOST=0.0.0.0` for a
container or a managed runtime. `LENS_ADAPTER=mock` is the offline default;
the Compose deployment defaults to `scrapling`.

## Offline checks

The single reproducible check command is:

```sh
make check
```

It runs TypeScript and Python typechecking, both offline test suites, lockfile
checks, and a production TypeScript build. The tests use `MockLensAdapter`,
Scrapling selector fixtures and a fake Redis; they do not launch a browser,
contact Google, or access SerpApi/OpenAI.

Individual commands:

```sh
npm test             # 12+ offline behavior tests
npm run typecheck
npm run build
uv run pytest -q
uv run mypy scrapling_worker
```

## HTTP API

### One image

`POST /search.json` (also available as `/search`, `/v1/search`, and
`/v1/lens/search`) accepts a multipart field named `image`. The upload must be a
JPEG, PNG, or WebP whose magic bytes match its declared MIME type.
`engine=google_lens` is the only supported engine. In production, send an API
key with `Authorization: Bearer ...` or `X-API-Key`.

```sh
curl -F image=@./image.png \
  -H 'Authorization: Bearer change-me' \
  'http://127.0.0.1:3000/search.json?engine=google_lens&hl=en&type=visual_matches'
```

The compatibility upload flow is:

```sh
IMAGE_ID=$(curl -fsS -F image=@./image.png http://127.0.0.1:3000/image | node -e "process.stdin.on('data', d => process.stdout.write(JSON.parse(d).image_id))")
curl -fsS "http://127.0.0.1:3000/search.json?engine=google_lens&image_id=${IMAGE_ID}&type=all"
```

`GET /search` and `GET /search.json` also accept a public `url`. The server
resolves and validates every host, blocks private/link-local/metadata ranges,
limits redirects and bytes, and rejects unsupported content. It does not fetch
arbitrary local paths.

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

`POST /v1/lens/batch` (also `/v1/batches`) accepts up to `MAX_BATCH_SIZE`
repeated `image` parts, `image_id` fields, or public `url` fields and returns a
batch ID. Poll `GET /v1/lens/batch/:id` (also `/v1/batches/:id`) for aggregate
counts and child jobs. Batch uploads share the same upload size, pixel, MIME,
queue and SSRF checks.

```sh
curl -fsS \
  -F image=@./image-01.png -F image=@./image-02.png \
  -F image=@./image-03.png \
  'http://127.0.0.1:3000/v1/lens/batch?engine=google_lens&type=visual_matches'
```

For 30 images, repeat the `-F image=@...` part 30 times or submit previously
created `image_id` fields. Each child job has its own terminal state and status
URL. Batch aggregates use `queued`, `running`, `retry_pending`, `completed`,
`completed_with_errors`, `failed`, or `cancelled`; a failure or challenge in one
child does not turn into an empty success or discard unrelated child results.

### Operations

- `GET /healthz` and `/health/live` — liveness and queue/worker information
- `GET /readyz` and `/health/ready` — readiness; the Scrapling worker requires
  Redis, a fresh heartbeat, and both explicit live-operation gates in live mode
- `GET /metrics` — Prometheus text metrics
- `GET /openapi.json` — OpenAPI 3.0 document

## Redis Streams Scrapling adapter

Set the production adapter and durable backends as follows:

```dotenv
LENS_ADAPTER=scrapling
QUEUE_BACKEND=redis
REDIS_URL=redis://redis:6379
IMAGE_STORAGE_BACKEND=file
IMAGE_STORAGE_DIR=/var/lib/lens/images
```

The TypeScript API publishes one reference-only entry to stream
`lens:jobs:v1`, consumed by group `scrapling-workers`. The entry contains
`job_id`, `attempt`, `image_id`, and JSON search options (`options_json`, with the legacy
`options` alias). The worker reads `IMAGE_STORAGE_DIR/<image_id>` and writes a
short-retention JSON result to `lens:result:v1:<job_id>`. The API polls that
key with an overall timeout, maps normalized results or page snapshots to the
existing parser, and reports challenge, worker-timeout, empty, browser, and
parser failures using the existing typed job errors.

`RedisJobPersistence` stores job/batch metadata and results under versioned
Redis keys and restores them before workers start. Terminal writes use an
atomic Redis compare-and-set script, and cancellation markers prevent late
worker results from replacing cancelled jobs. `FileImageStore` writes the
validated bytes and JSON metadata atomically beneath `IMAGE_STORAGE_DIR`,
enforces retention/max-record cleanup, and rejects unsafe deletion paths.

The offline contract tests use mocked Redis and never start a Redis server or a
browser. The TypeScript API does not construct or manage a browser when
`scrapling` is selected.

## Scrapling live worker

The production browser path is the separate Python Scrapling worker. It uses
the documented `AsyncDynamicSession` API and receives image references through
Redis Streams; the Fastify process never owns a browser. The worker is disabled
by default. For an authorized live deployment, configure both services with:

```sh
LENS_ADAPTER=scrapling \
SCRAPLING_WORKER_MODE=live \
GOOGLE_LENS_LIVE_ENABLED=true \
GOOGLE_LENS_LIVE_AUTHORIZED=I_UNDERSTAND_AND_AUTHORIZE \
npm start
```

Run `uv run scrapling-worker` separately with the same Redis URL, image-storage
directory, and live gates. The Compose file starts both processes as separate
services.

The exact authorization value is an operational gate, not proof that Google
has granted permission. The worker opens the visible Search by image workflow,
uploads each shared image, waits for observable DOM result/challenge states and
extracts sanitized data through Scrapling selectors. It does not use stealth,
proxies, CAPTCHA solving, account profiles, fingerprint spoofing or private
Google endpoints.

## Docker and deployment

The multi-stage Dockerfile pins Node 22.14.0 and runs the API as the
unprivileged `node` user. `Dockerfile.scrapling-worker` pins Python 3.12.4 and
Scrapling 0.4.15. The Compose deployment includes the API, Redis, and the
separate Scrapling worker; override `LENS_ADAPTER=mock` and
`SCRAPLING_WORKER_MODE=disabled` for an offline API-only smoke run.

```sh
docker build -t standalone-google-lens-api:local .
```

Or use the local compose configuration:

```sh
docker compose up --build
```

For an offline image-only smoke run, use `LENS_ADAPTER=mock` with
`IMAGE_STORAGE_BACKEND=memory`. For a deployment, provide environment
variables through the platform secret store or environment configuration. No
secret, API key, cookie, or token is stored in this repository.
The Scrapling adapter uses a bounded local admission queue plus the durable
Redis Streams v1 worker contract; the API does not consume the same stream as
the Python worker. `RedisJobPersistence` restores queued/running jobs after an
API restart, and the worker result key makes duplicate delivery idempotent.

## Compliance gate

Google's current Terms of Service prohibit abuse, bypassing protective
measures, and automated access that violates machine-readable instructions.
Google's Search Help also explicitly classifies robots, computer programs,
automated services, and search scrapers as automated traffic. The project's
live gate is therefore off by default. A challenge is a terminal access
condition: the worker stops and records `lens_challenge`; it does not retry
aggressively, solve CAPTCHA, rotate proxies, spoof fingerprints, or farm
accounts. See `docs/research.md` and `docs/security.md` before any live
operation.

`LENS_ADAPTER=scrapling` is the production worker integration. It uses the
reference-only Redis contract described above; no CAPTCHA solver, stealth
plugin, proxy rotation, account farming, fingerprint evasion, or challenge
circumvention is added. `mock` remains the offline/test adapter; direct
Playwright automation has been retired.

## Documentation

- `docs/research.md` — source-backed research, feasibility and compliance gate
- `docs/adr-001.md` — architecture decision record and trade-offs
- `docs/api.md` — endpoint contract and compatibility mapping
- `docs/architecture.md` — queue, worker, browser and job-state design
- `docs/security.md` — data protection, SSRF and container controls
- `docs/operations.md` — deployment, rollback and troubleshooting runbook
- `docs/hardware.md` — VPS sizing and the commands still requiring SSH access
- `docs/rma-integration.md` — exact RMA provider configuration and rollout
- `docs/performance.md` — offline benchmark methodology and evidence boundaries
