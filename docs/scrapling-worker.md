# Scrapling worker

This repository includes a separate Python worker under `scrapling_worker/`.
It does not modify or import the TypeScript service's source files. The worker
consumes Redis Streams jobs produced by a host integration and writes a short
retained result before acknowledging the stream entry.

## Reproducible setup

Python `3.12.4` is pinned in `.python-version`. `uv.lock` is the authoritative
dependency lock; `requirements.lock` is a reviewable export for environments
that require a requirements file. All installs are project-local:

```sh
uv sync --locked --extra dev
uv run pytest -q
uv run mypy scrapling_worker
```

The tests use local HTML fixtures and a fake page/Redis implementation. They do
not launch Chrome, contact Google, or require a Redis server. The worker image
does install Google Chrome and Scrapling's transitive Playwright runtime libraries, but the image build
smoke check navigates only to a loopback fixture served inside the build step.

Build the worker image with:

```sh
docker build -f Dockerfile.scrapling-worker -t standalone-google-lens-scrapling-worker:local .
```

The image build installs the pinned Python packages and Google Chrome. The
final image runs as the unprivileged `worker` user and fails its build if
Chrome cannot launch.

The image defaults to `SCRAPLING_WORKER_MODE=disabled`. A production runner
must mount the same image directory used by the TypeScript producer at
`/data/images`, provide Redis, and set `SCRAPLING_WORKER_MODE=fixture` or
`live` deliberately. Compose sets this value explicitly and also passes
`LENS_DEPLOYMENT_MODE`; the worker exits with a configuration error if the two
modes disagree.

### Compose mode matrix

Compose never silently starts a disabled worker. Select one mode by setting
both variables to the same value:

| Mode | `LENS_DEPLOYMENT_MODE` | `SCRAPLING_WORKER_MODE` | Browser/network behavior |
| --- | --- | --- | --- |
| Fixture | `fixture` | `fixture` | Local HTML fixtures; no Google request and no browser required for a job |
| Live | `live` | `live` | Google Chrome is smoke-checked at worker startup; both live authorization gates are required |

For fixture mode, the API still uses Redis and the worker heartbeat, so
`/readyz` does not report ready until Redis and the worker are usable. Live mode
adds the browser smoke check before the first heartbeat; a missing or broken
Google Chrome therefore keeps readiness false instead of accepting browser work.

## Redis Streams v1 contract

### Job stream

The fixed stream and group names are:

| Item | Value |
| --- | --- |
| Stream | `lens:jobs:v1` |
| Consumer group | `scrapling-workers` |
| Result key | `lens:result:v1:<job_id>:<attempt>` |
| Cancellation key | `lens:cancel:v1:<job_id>` |
| Heartbeat key | `lens:worker:heartbeat:v1` |

The producer uses `XADD lens:jobs:v1 *` with string fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `job_id` | yes | Stable job ID, used for idempotency and output lookup |
| `dispatch_id` | yes | Stable ownership token for one API dispatch, normally `<job_id>:<attempt>` |
| `attempt` | yes | API-owned monotonic attempt number; worker does not maintain a second counter |
| `image_id` | yes | Basename of the shared image file |
| `options_json` | no | JSON object containing the search options |
| `engine` | no | Defaults to `google_lens` |
| `type` | no | `all`, `visual_matches`, or `exact_matches`; defaults to `all` |
| `q`, `hl`, `country`, `safe` | no | Wire fields understood by the parser, but rejected by the live API because the current browser action cannot apply them |
| `auto_crop`, `no_cache`, `async_request` | no | Boolean option fields; `auto_crop` is rejected by the live API, while the other two are service-level controls |
| `created_at` | no | Producer ISO-8601 timestamp |
| `fixture` | no | Fixture name when running in `fixture` mode |

`options_json` may use the TypeScript spellings `autoCrop`, `noCache`, and
`async`; direct fields use the snake-case names above. The worker rejects an
unsupported engine/type rather than silently changing the request. The API
rejects live `q`, `hl`, `country`, `safe`, and `auto_crop` before publishing a
job, so a successful live result never echoes an unapplied search option.

Image bytes are never put in Redis. The worker reads exactly
`IMAGE_STORAGE_DIR/<image_id>` after rejecting path traversal and absolute
paths. The producer and worker must share that directory or mount.

### Result value

Before `XACK`, the worker writes `SETEX lens:result:v1:<job_id>:<attempt> <ttl> <json>`.
The value is an envelope:

```json
{
  "schema_version": "lens.result.v1",
    "job_id": "job-123",
    "dispatch_id": "job-123:1",
  "status": "succeeded",
  "attempt": 1,
  "result": {
    "search_metadata": {
      "id": "job-123",
      "status": "Success",
      "json_endpoint": "/v1/jobs/job-123",
      "created_at": "2026-01-01T00:00:00Z",
      "processed_at": "2026-01-01T00:00:01Z",
      "total_time_taken": 1.0,
      "cached": false,
      "source": "scrapling"
    },
    "search_parameters": {"engine": "google_lens", "type": "all"},
    "visual_matches": [],
    "exact_matches": [],
    "related_content": []
  },
  "error": null
}
```

The `result` object uses the normalized visual-match shape consumed by
the TypeScript parser: `search_metadata`, `search_parameters`, visual/exact
matches, and optional related content. Match items use the TypeScript field
names after normalization: `position`, `title`, `link`, `source`,
`source_icon`, `thumbnail`, `image`, `image_width`, `image_height`, `price`,
`extracted_price`, `currency`, and `rating`. Only observed values are emitted.

For terminal failure or cancellation, `result` is `null` and `error` contains
`code`, `message`, `retryable`, and optional `dead_letter`. Codes are compatible
with the existing service (`lens_challenge`, `lens_loading`, `lens_empty`,
`lens_parser`, `lens_browser`, `cancelled`, and `retry_exhausted`). A result
already present for a job is treated as authoritative and the duplicate stream
entry is acknowledged without running the adapter again.

## Normalized snapshot

The dedicated parser first builds this in-memory snapshot from Scrapling CSS
selectors; it is not a second network protocol:

```json
{
  "url": "https://lens.google.com/",
  "title": "Visual matches",
  "bodyText": "...",
  "links": [{
    "href": "https://example.test/item",
    "text": "Example product",
    "source": "example.test",
    "sourceIcon": "https://example.test/favicon.ico",
    "thumbnail": "https://cdn.example.test/thumb.jpg",
    "image": "https://cdn.example.test/image.jpg",
    "imageWidth": 640,
    "imageHeight": 480,
    "price": "$29.99",
    "extractedPrice": 29.99,
    "currency": "$",
    "rating": 4.5
  }],
  "exactMatches": [],
  "relatedContent": [{"query": "example product", "href": "https://example.test/search"}],
  "loading": false,
  "observedAt": "2026-01-01T00:00:00Z",
  "timings": {"adapterMs": 10}
}
```

The parser classifies observable challenge, loading, empty, and unparseable
states. Challenges stop processing; no CAPTCHA solver, proxy rotation,
fingerprint spoofing, account farming, or challenge bypass is implemented.

## Live Scrapling path

The live adapter is explicit and disabled unless all of the following are true:

```sh
SCRAPLING_WORKER_MODE=live \
GOOGLE_LENS_LIVE_ENABLED=true \
GOOGLE_LENS_LIVE_AUTHORIZED=I_UNDERSTAND_AND_AUTHORIZE \
uv run scrapling-worker
```

It uses Scrapling `AsyncStealthySession` 0.4.15 with installed Google Chrome.
The worker keeps one session warm, then opens a new page for each image. The
action selects Google's Lens `encoded_image` input, uploads the shared file,
and waits for observable result, challenge, or empty states. Scrapling
selectors parse the returned page. The worker does not use proxy rotation,
CAPTCHA solving, account profiles, or undocumented Google endpoints. Live
mode is never used by the automated offline tests.

If the page shows a CAPTCHA, robot check, unusual-traffic message, or human
verification prompt, `lens_challenge` is written as a non-retryable terminal
result and the stream entry is acknowledged. A challenge is never converted to
an empty success and is never passed to a solver or bypass flow.

## Recovery and shutdown

The API owns the bounded `attempt` number and publishes a new `dispatch_id` for
each retry. A retryable worker failure is written as a retryable terminal result
and ACKed; the API then republishes the same job with the next dispatch token.
`XAUTOCLAIM` still recovers entries interrupted before their result is written,
and duplicate delivery is acknowledged when a result already exists. A
cancellation key is checked before reading the image and after the adapter
returns. `SIGINT`/`SIGTERM` stop the polling loop; the Redis blocking read is
bounded by `LENS_BLOCK_MS`, and the adapter closes in a `finally` block.

Logs are one-line JSON events. Job IDs are SHA-256 prefixes, and image bytes,
image paths, result URLs, credentials, and arbitrary browser exception text are
not logged.

The worker refreshes the heartbeat key with a short TTL only after Redis group
setup and the adapter readiness check succeed. The API readiness endpoint
returns not-ready when Redis is unavailable, the selected worker heartbeat is
absent or stale, or a live Google Chrome startup check failed; process liveness
remains separately observable through `/healthz`.
