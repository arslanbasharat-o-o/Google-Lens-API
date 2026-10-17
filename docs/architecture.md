# Architecture

## Runtime flow

```mermaid
flowchart LR
  RMA[RMA System] -->|API key + multipart| API[Fastify Lens API]
  API --> V[Validation + SHA-256]
  V --> S[(Short-retention image store)]
  V --> Q[(Bounded queue)]
   Q --> P[Bounded local dispatcher]
    P --> S2[Redis Streams lens:jobs:v1]
    S2 --> W[Python Scrapling worker]
    W --> C[AsyncDynamicSession / isolated page]
    C --> G[Google Lens website<br/>only when authorized]
    G --> R[Redis result key lens:result:v1:job_id]
    R --> X[DOM snapshot or normalized result]
  X --> Parser[Fixture-tested parser]
  Parser --> Cache[(TTL response cache)]
  Cache --> API
  API --> RMA
```

The Fastify API and bounded dispatcher remain one deployable process. Scrapling
execution is an external Python worker; Redis Streams and durable image/job
storage keep browser work independent from HTTP request lifetime.

## Components

1. **HTTP layer** (`src/http/app.ts`) exposes the SerpApi-compatible aliases,
   validates multipart bytes and search parameters, enforces API keys/rate
   limits, and keeps request bodies bounded.
2. **Image boundary** (`src/http/uploads.ts`, `src/storage/image-store.ts`)
   checks JPEG/PNG/WebP signatures, dimensions and pixel count, hashes bytes,
   and retains uploaded images only for a short configurable period. Production
   `FileImageStore` atomically writes `<image_id>` plus metadata beneath
   `IMAGE_STORAGE_DIR` and removes expired, over-limit, orphaned, or unsafe files.
3. **Remote URL boundary** (`src/services/remote-image.ts`) follows only
   bounded HTTP(S) redirects and rejects local, private, link-local and
   metadata address ranges before every fetch.
4. **Queue/worker layer** (`src/queue`, `src/workers`) applies admission
   control, bounded retries with jitter, dead-letter metadata and cancellation.
   `InMemoryJobQueue` is the offline default. `RedisJobQueue` provides a
   central Redis list for legacy/local admission, while `RedisStreamsJobQueue`
   documents the `lens:jobs:v1`/`scrapling-workers` transport contract. The
   Scrapling production path deliberately does not consume the same stream from
   TypeScript, avoiding a consumer-group race with Python.
   `RedisJobPersistence` hydrates job/batch metadata and results with atomic
   terminal commits and cancellation markers. Cache hits are served before
   queue admission, and equivalent in-flight work is coalesced per principal.
 5. **Scrapling adapter/parser boundary** (`src/adapters`, `src/parser`) keeps browser
   interaction and normalized output independent. `ScraplingRedisAdapter`
   publishes references, polls an overall timeout, maps snapshots/results,
   and classifies challenge/timeout failures; attempt numbers prevent a late
   retry result from winning. The mock adapter and sanitized
   fixtures are used for all offline tests.
 6. **Cache/metrics** (`src/services/cache.ts`, `src/services/metrics.ts`) use
   SHA-256 plus all result-affecting search parameters for TTL cache keys and
   emit Prometheus text counters and bounded percentile samples.

## Job state model

```text
queued -> running -> succeeded
                 \-> failed -> dead_letter metadata when retries exhausted
                 \-> queued (bounded retry with jitter)
queued/running -> cancelled
```

Every batch child has an independent ID and terminal state. A challenge is not
converted into an empty success. Aggregate batches expose `retry_pending` while
bounded retry work is waiting, `completed_with_errors` when at least one child
succeeds and another fails/cancels, and `failed` when all terminal children fail;
the child status payload preserves the exact error classification.

## Browser isolation and lifecycle

- The production API does not launch or manage a browser.
- The Python worker uses Scrapling `AsyncDynamicSession` with configurable
  `max_pages`; the default is one page for conservative resource use.
- Each job uploads through a visible file input and the session closes after
  the job. Reuse is never treated as a browser-context isolation guarantee.
- Increase `SCRAPLING_MAX_PAGES` only after measuring memory and proving that
  the pinned Scrapling session resets page state between jobs.
- No Google account profile, cookie jar, proxy rotation, stealth plugin,
  fingerprint spoofing, or CAPTCHA-solving service is used.

## Deployment boundary

Redis is private to the Compose network and is never published to the host.
The API container runs as the unprivileged Node user with a read-only root
filesystem, a bounded `/tmp`, dropped Linux capabilities and resource limits.
TLS termination belongs at the existing reverse proxy. See
`docs/operations.md` for backup and rollback gates.
