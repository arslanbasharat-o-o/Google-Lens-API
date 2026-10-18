# Standalone Google Lens API

An authenticated Google Lens search service for display-identification
workflows. It combines a TypeScript API with a separate Scrapling worker running
Google Chrome. Redis carries job references and results; image bytes stay in
private storage. Development and automated tests use offline fixtures.

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
npm ci
uv sync --locked --extra dev
npm run build
API_AUTH_REQUIRED=false LENS_ADAPTER=mock QUEUE_BACKEND=memory npm start
```

The server listens on `127.0.0.1:3000` by default. Set `HOST=0.0.0.0` only in a
container or behind an authenticated TLS reverse proxy. `LENS_ADAPTER=mock`
with an in-memory queue is the offline default; the Compose deployment uses the
Redis-backed Scrapling contract and an explicit fixture or live mode.

## Offline checks

The single reproducible check command is:

```sh
make check
```

It runs TypeScript and Python typechecking, both offline test suites, lockfile
checks, and a production TypeScript build. The tests use `MockLensAdapter`,
Scrapling selector fixtures and a fake Redis; they do not launch a browser,
contact Google, or call paid recognition APIs.

Individual commands:

```sh
npm test               # Offline behavior tests; one recovery test needs REDIS_URL
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
  -H "Authorization: Bearer $API_KEYS" \
  'http://127.0.0.1:3000/search.json?engine=google_lens&hl=en&type=visual_matches'
```

The compatibility upload flow is:

```sh
IMAGE_ID=$(curl -fsS -F image=@./image.png http://127.0.0.1:3000/upload | node -e "process.stdin.on('data', d => process.stdout.write(JSON.parse(d).image_id))")
curl -fsS "http://127.0.0.1:3000/search.json?engine=google_lens&image_id=${IMAGE_ID}&type=all"
```

`GET /search` and `GET /search.json` also accept a public `url`. The server
resolves and validates every host, blocks private/link-local/metadata ranges,
including IPv4-mapped IPv6 forms, pins each request to the validated address,
limits redirects and bytes, and rejects unsupported content. It does not fetch
arbitrary local paths.

Search options include `type`, `q`, `hl`, `country`, `safe`, `auto_crop`,
`no_cache`, and `async`. The offline mock accepts and includes all result
options in its contract output. The live
Scrapling adapter rejects `q`, `hl`, `country`, `safe`, and `auto_crop` with a
`400 validation_error` because that worker contract does not apply them; it
never returns those fields as if they were applied. `type`, `no_cache`, and
`async` remain supported service-level controls.

Fast jobs return HTTP 200 with a normalized visual-match response:

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
queue and SSRF checks. `MAX_BATCH_BYTES` (50 MiB by default) bounds aggregate
image bytes retained by one multipart or reference batch before jobs are
admitted.

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
  usable Redis, a fresh worker heartbeat, and (in live mode) a successful
  Google Chrome startup check plus both explicit live-operation gates
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
`job_id`, `attempt`, `dispatch_id`, `image_id`, and JSON search options (`options_json`, with the legacy
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

## Scrapling live worker and residential proxy support

The production browser path is the separate Python Scrapling worker. It uses
the documented `AsyncStealthySession` API with installed Google Chrome and receives image references through
Redis Streams; the Fastify process never owns a browser. The worker is disabled
by default in the standalone image. For an authorized live deployment, configure both services with:

```sh
LENS_ADAPTER=scrapling \
LENS_DEPLOYMENT_MODE=live \
SCRAPLING_WORKER_MODE=live \
GOOGLE_LENS_LIVE_ENABLED=true \
GOOGLE_LENS_LIVE_AUTHORIZED=I_UNDERSTAND_AND_AUTHORIZE \
npm start
```

Run `uv run scrapling-worker` separately with the same Redis URL, image-storage
directory, and live gates. The Compose file starts both processes as separate
services.

### Residential and mobile proxy routing

Google Lens enforces strict anti-bot and datacenter IP heuristics. The Scrapling worker supports authenticated residential and mobile proxies via `SCRAPLING_PROXY_URL`:

- **Supported Formats**: Standard URI (`http://user:pass@host:port`, `socks5://user:pass@host:port`) and colon-delimited formats (`host:port:user:pass`). The worker automatically normalizes them to valid Playwright/Chromium proxy configurations.
- **Sticky Session Handshake**: Uploading an image to Google Lens involves a multi-step sequence (navigating to Google, clicking `[aria-label="Search by image"]`, uploading the binary payload, and following redirects). The proxy manager keeps the residential IP sticky (`sesstime_30`) throughout this sequence to prevent session invalidation and CSRF failures.
- **Dynamic Rotation on Challenge (`rotate_proxy_session`)**: When Google issues a human-verification prompt or a job completes, the worker dynamically generates a new session token, causing the proxy provider (such as AnyIP, BrightData, or Oxylabs) to allocate a clean, fresh residential IP address for the next query.
- **Stealth Evasion**: Scrapling runs with Chrome anti-detection flags enabled: `google_search=True`, `disable_resources=True`, `block_webrtc=True`, and `real_chrome=True`.

### Challenge circuit-breaker and cooldown

When an exact image triggers a Google verification prompt, the API's in-memory circuit breaker can temporarily suppress identical immediate re-queries to avoid burning residential pool IPs:

- `LENS_CHALLENGE_COOLDOWN_MS`: Sets the cooldown duration in milliseconds (defaults to 10 minutes; set to `0` or `<= 0` to disable suppression).
- **`no_cache=true` Bypass**: Sending `no_cache=true` on `POST /search.json` automatically clears any active challenge cooldown for that image and forces an immediate live retry through a fresh proxy session.

### Pending job reclaim safety

Version 1.0.6 enforces a strict pending-job reclaim window:
- The worker configuration enforces that `LENS_RECLAIM_IDLE_MS` is strictly greater than `SCRAPLING_BROWSER_TIMEOUT_MS` plus a 30-second buffer.
- First-writer-wins Redis persistence ensures that late duplicate executions cannot overwrite an already-completed result with a stale timeout or challenge.

## Docker and deployment

The multi-stage Dockerfile pins Node 22.14.0 and runs the API as the
unprivileged `node` user. `Dockerfile.scrapling-worker` pins Python 3.12.4 and
Scrapling 0.4.15, installs Google Chrome plus its Linux runtime libraries, and runs
an offline browser smoke check in the final non-root image. The Compose
deployment includes the API, Redis, and the separate Scrapling worker.

```sh
docker build -t google-lens-api:local .
```

Or use the local compose configuration:

```sh
cp .env.example .env
# Set API_KEYS and runtime proxy in .env through the deployment secret store.
docker compose --env-file .env config --quiet
docker compose --env-file .env up --build
```

The Compose fixture deployment is selected with matching
`LENS_DEPLOYMENT_MODE=fixture` and `SCRAPLING_WORKER_MODE=fixture`. For an
authorized live deployment, set both to `live` and also set
`GOOGLE_LENS_LIVE_ENABLED=true` and
`GOOGLE_LENS_LIVE_AUTHORIZED=I_UNDERSTAND_AND_AUTHORIZE`. Mismatched modes
fail during worker startup rather than leaving the API with a misleading
heartbeat.

For an offline image-only smoke run, use `LENS_ADAPTER=mock` with
`QUEUE_BACKEND=memory` and `IMAGE_STORAGE_BACKEND=memory`. For a deployment, provide environment
variables through the platform secret store or environment configuration. No
secret, API key, cookie, or token is stored in this repository.
The Scrapling adapter uses durable Redis Streams admission plus a bounded local
polling queue; the API does not consume the same stream consumer group as the
Python worker. `RedisJobPersistence` restores queued/running jobs after an API
restart, and the dispatch-owned worker result makes duplicate delivery
idempotent.

## Published containers

The release workflow publishes versioned and `latest` images to GitHub Container
Registry:

| Image | Versioned Tag | Latest Tag | Description |
| :--- | :--- | :--- | :--- |
| `ghcr.io/arslanbasharat-o-o/google-lens-api` | `1.0.6` | `latest` | Fastify TypeScript API gateway |
| `ghcr.io/arslanbasharat-o-o/google-lens-scrapling-worker` | `1.0.6` | `latest` | Python Scrapling + Camoufox Chrome worker |

Releases are published from version tags on `main`. Production images use the
MIT-licensed source in this repository. Keep the API behind TLS and
authentication; do not expose Redis or image storage.

## Compliance and operational boundaries

Google's Terms of Service prohibit abusive automation and bypassing protective
measures. The project's live gate is therefore off by default (`GOOGLE_LENS_LIVE_ENABLED=false`).
When live operation is explicitly enabled by the operator, the worker uploads
through genuine browser interactions using standard file inputs, respects timeout
boundaries, and handles challenges cleanly with session resets and cooldowns rather
than aggressive spamming. See `docs/security.md` before enabling live operation.

`LENS_ADAPTER=scrapling` is the production worker integration. It uses the
reference-only Redis contract described above. `mock` remains the offline/test
adapter. Our code does not import Playwright directly; Scrapling's Chrome
sessions retain Playwright as a transitive implementation dependency.

## Documentation

- `docs/api.md` — endpoint contract and compatibility mapping
- `docs/architecture.md` — queue, worker, browser and job-state design
- `docs/security.md` — data protection, SSRF and container controls
- `docs/operations.md` — deployment, rollback and troubleshooting runbook
- `docs/rma-integration.md` — exact RMA provider configuration and rollout
