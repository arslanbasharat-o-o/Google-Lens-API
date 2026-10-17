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
not launch Chromium, contact Google, or require a Redis server. The optional
browser dependencies are present for the explicitly gated live path only.

Build the worker image with:

```sh
docker build -f Dockerfile.scrapling-worker -t standalone-google-lens-scrapling-worker:local .
```

The default image build installs the pinned Python/browser automation packages
but skips the large Chromium download, so the disabled and fixture modes build
without a browser CDN. For an authorized live image, opt in explicitly and
allow the build environment to reach the Playwright browser CDN:

```sh
docker build -f Dockerfile.scrapling-worker \
  --build-arg INSTALL_SCRAPLING_BROWSERS=true \
  -t standalone-google-lens-scrapling-worker:live .
```

The image defaults to `SCRAPLING_WORKER_MODE=disabled`. A production runner
must mount the same image directory used by the TypeScript producer at
`/data/images`, provide Redis, and set `SCRAPLING_WORKER_MODE=fixture` or
`live` deliberately.

## Redis Streams v1 contract

### Job stream

The fixed stream and group names are:

| Item | Value |
| --- | --- |
| Stream | `lens:jobs:v1` |
| Consumer group | `scrapling-workers` |
| Result key | `lens:result:v1:<job_id>` |
| Cancellation key | `lens:cancel:v1:<job_id>` |
| Attempt key | `lens:attempt:v1:<job_id>` |

The producer uses `XADD lens:jobs:v1 *` with string fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `job_id` | yes | Stable job ID, used for idempotency and output lookup |
| `image_id` | yes | Basename of the shared image file |
| `options_json` | no | JSON object containing the search options |
| `engine` | no | Defaults to `google_lens` |
| `type` | no | `all`, `visual_matches`, or `exact_matches`; defaults to `all` |
| `q`, `hl`, `country`, `safe` | no | Search options copied into the normalized response |
| `auto_crop`, `no_cache`, `async_request` | no | Boolean option fields |
| `created_at` | no | Producer ISO-8601 timestamp |
| `fixture` | no | Fixture name when running in `fixture` mode |

`options_json` may use the TypeScript spellings `autoCrop`, `noCache`, and
`async`; direct fields use the snake-case names above. The worker rejects an
unsupported engine/type rather than silently changing the request.

Image bytes are never put in Redis. The worker reads exactly
`IMAGE_STORAGE_DIR/<image_id>` after rejecting path traversal and absolute
paths. The producer and worker must share that directory or mount.

### Result value

Before `XACK`, the worker writes `SETEX lens:result:v1:<job_id> <ttl> <json>`.
The value is an envelope:

```json
{
  "schema_version": "lens.result.v1",
  "job_id": "job-123",
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
      "source": "playwright-google-lens"
    },
    "search_parameters": {"engine": "google_lens", "type": "all"},
    "visual_matches": [],
    "exact_matches": [],
    "related_content": []
  },
  "error": null
}
```

The `result` object is the same normalized SerpApi-compatible shape consumed by
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
GOOGLE_LENS_LIVE_AUTHORIZED=true \
uv run scrapling-worker
```

It uses the official Scrapling `AsyncDynamicSession` 0.4.15 API with
`max_pages`, an async `page_setup`, and an async `page_action`. The action
locates a normal visible `input[type="file"]`, uploads the shared file through
that control, and waits for observable result/challenge/empty DOM states. The
returned Scrapling page is parsed with Scrapling selectors. It does not use
`StealthyFetcher`, proxy rotation, CAPTCHA solving, fingerprint manipulation,
account profiles, or undocumented Google endpoints. Live mode requires a
separate authorization decision and is never used by tests.

## Recovery and shutdown

The worker calls `XAUTOCLAIM` for idle pending entries, with the bounded
`LENS_MAX_ATTEMPTS` counter stored at `lens:attempt:v1:<job_id>`. Retryable
loading/browser failures remain pending until a reclaim; terminal errors are
SETEXed then ACKed. A cancellation key is checked before reading the image and
after the adapter returns. `SIGINT`/`SIGTERM` stop the polling loop; the Redis
blocking read is bounded by `LENS_BLOCK_MS`, and the adapter closes in a
`finally` block.

Logs are one-line JSON events. Job IDs are SHA-256 prefixes, and image bytes,
image paths, result URLs, credentials, and arbitrary browser exception text are
not logged.
