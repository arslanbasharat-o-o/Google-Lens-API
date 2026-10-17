# API contract

The canonical machine-readable document is served at `GET /openapi.json`.
All compatibility endpoints accept an API key when `API_AUTH_REQUIRED=true`.
Use `Authorization: Bearer <key>` or `X-API-Key: <key>`; query-string
`api_key` is accepted only for legacy compatibility and should not be used over
an unencrypted connection.

## Upload and single search

```text
POST /image
POST /upload                 # compatibility alias
Content-Type: multipart/form-data, field image
-> 201 { image_id, sha256, mime_type, size, expires_at }
```

`GET /search` and `GET /search.json` accept:

- `engine=google_lens` (required semantically; defaults to this value)
- exactly one of `image_id` or `url`
- `type=all|visual_matches|exact_matches`
- `hl`, `country`, `q`, `no_cache`, and `async`

The remote URL path is SSRF-protected and uses the same image signature,
dimension and byte checks as upload. `async=true` returns `202` immediately.

Direct upload routes:

```text
POST /search
POST /search.json
POST /v1/search
POST /v1/lens/search
Content-Type: multipart/form-data, field image
```

These routes return `200` when a job finishes within `SEARCH_SYNC_WAIT_MS`, or
`202` with `job_id` and `status_url` otherwise.

## Batch

```text
POST /v1/lens/batch
POST /v1/batches                # alias
```

Use repeated `image` parts, repeated `image_id` fields, or repeated `url`
fields. A batch has one aggregate ID and one independent job ID per image.
`GET /v1/lens/batch/:id` and `GET /v1/batches/:id` expose counts and child
states. `DELETE /v1/lens/jobs/:id` cancels a queued/running job cooperatively.

## Response mapping

The compatibility response has this shape:

```json
{
  "search_metadata": {
    "id": "job-id",
    "status": "Success",
    "json_endpoint": "/v1/jobs/job-id",
    "total_time_taken": 0.42,
    "cached": false,
    "source": "mock"
  },
  "search_parameters": {
    "engine": "google_lens",
    "type": "visual_matches"
  },
  "visual_matches": [
    {
      "position": 1,
      "title": "Example product",
      "link": "https://example.test/product",
      "source": "example.test",
      "source_icon": "https://example.test/favicon.ico",
      "thumbnail": "https://cdn.example.test/thumb.jpg",
      "image": "https://cdn.example.test/image.jpg",
      "price": "$29.99",
      "extracted_price": 29.99,
      "currency": "USD"
    }
  ],
  "exact_matches": [],
  "related_content": []
}
```

Only fields observed in the page are emitted. The service never invents prices,
model numbers, URLs or source data and never returns fictitious `serpapi.com`
links.

## Error classes

| Code | Meaning | Retry policy |
| --- | --- | --- |
| `validation_error` | Invalid MIME, size, dimensions, query or multipart body | Do not retry unchanged input |
| `unauthorized` | Missing or invalid API key | Fix credentials |
| `rate_limited` / `queue_full` | Admission control rejected work | Retry after backoff |
| `lens_challenge` | Google requested human verification or access was challenged | Stop; no aggressive retry |
| `lens_loading` / `lens_browser` | Bounded browser wait or browser crash | Bounded jittered retry |
| `lens_empty` | Google returned no visual matches | Do not convert into success for RMA |
| `lens_parser` | Page was available but result data was not parseable | Review fixture/selector diagnostics |
| `remote_fetch_error` | URL could not be safely fetched | Fix URL or host |

## Scrapling worker contract

When `LENS_ADAPTER=scrapling`, the API publishes reference-only Redis Streams
messages. The stable v1 names are:

```text
stream:        lens:jobs:v1
consumer group: scrapling-workers
result key:    lens:result:v1:<job_id>
fields:        job_id, image_id, options_json (and legacy options alias)
```

`image_id` resolves to `IMAGE_STORAGE_DIR/<image_id>`; image bytes are never
placed in the stream or job message. Worker results may contain a normalized
`result` or a Lens page `snapshot`. The API polls the result key until
`SCRAPLING_RESULT_TIMEOUT_MS`, then reports `lens_timeout`; challenge and
worker error payloads are mapped to the existing typed `lens_challenge`,
`lens_empty`, `lens_browser`, or parser errors. Cancelled jobs write a
`lens:cancel:v1:<job_id>` marker when Redis persistence is enabled, and late
terminal commits are ignored.
