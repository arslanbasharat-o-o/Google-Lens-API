# Architecture

The service is deliberately a small vertical slice with explicit boundaries:

1. **HTTP layer** (`src/http/app.ts`) accepts only bounded multipart image
   uploads, sniffs JPEG/PNG/WebP magic bytes, and translates requests into
   jobs. It does not pass user-controlled paths to the filesystem.
2. **Hash/cache layer** (`src/services/hash.ts`, `src/services/cache.ts`)
   builds a SHA-256 image plus option key and keeps only bounded, expiring
   normalized results in memory.
3. **Queue/worker layer** (`src/queue`, `src/workers`) separates admission from
   browser work. `InMemoryJobQueue` is bounded and is the default. The
   `BullMqEnqueueBoundary` documents the compatible payload for a Redis/BullMQ
   producer without forcing Redis into offline tests.
4. **Adapter/parser boundary** (`src/adapters`, `src/parser`) keeps browser
   automation and DOM extraction independent from response normalization. The
   mock adapter is deterministic and is used by tests.
5. **Job store** (`src/storage/job-store.ts`) is a bounded in-memory status
   store with terminal waiters, job TTL pruning, and batch aggregation.

## Live adapter policy

`PlaywrightLensAdapter` navigates to the configured public Lens UI, uses the
visible DOM file input, waits for observable DOM state, and extracts visible
anchor text and URLs. It does not use private API calls, stealth plugins,
proxy rotation, fingerprint evasion, or CAPTCHA solving. Challenge pages are
reported as `lens_challenge` and stop the job.

Live work requires both:

```text
GOOGLE_LENS_LIVE_ENABLED=true
GOOGLE_LENS_LIVE_AUTHORIZED=I_UNDERSTAND_AND_AUTHORIZE
```

The default adapter is `mock`; the defaults never run a Google query.
