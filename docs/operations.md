# Operations runbook

## Local verification

```sh
cp .env.example .env
npm ci
make check
```

The default adapter is mock, so the check is offline and does not contact
Google, SerpApi or OpenAI. `docker compose config` validates the Compose
interpolation without starting production services.

## Compose deployment

1. Confirm a backup and rollback image/tag for the RMA system before adding the
   service. Do not modify existing RMA PostgreSQL or image volumes.
2. Create an owner-only `.env` from `.env.example`; set `API_KEYS` through a
   secret manager and set `API_AUTH_REQUIRED=true`.
3. Keep `LENS_ADAPTER=mock` until the authorization gate and a bounded live
   acceptance test have been reviewed.
4. Choose `QUEUE_BACKEND=memory` for one-process testing or `redis` when the
   private Redis service is part of the deployment. For production, use
   `LENS_ADAPTER=scrapling`, `IMAGE_STORAGE_BACKEND=file`, and the same shared
   `IMAGE_STORAGE_DIR` in the API and worker containers.
5. Build and start:

   ```sh
   docker compose build
   docker compose up -d
   docker compose ps
   curl -fsS http://127.0.0.1:3000/healthz
   curl -fsS http://127.0.0.1:3000/readyz
   ```

The Compose API has no host Redis port. Put TLS and an authenticated reverse
proxy in front of the API; do not publish the service directly on the public
internet without TLS.

## Scrapling worker contract

The API and worker share Redis stream `lens:jobs:v1` and consumer group
`scrapling-workers`. Each message carries `job_id`, `image_id`, and serialized
options, never image bytes. The worker reads the bare image ID below
`IMAGE_STORAGE_DIR` and writes `lens:result:v1:<job_id>`. Keep the image volume
private and mounted at the same path for both containers. The API's overall
poll timeout is controlled by `SCRAPLING_RESULT_TIMEOUT_MS`.

## Live Scrapling operation gate

Live operation additionally requires written authorization and a reviewed
privacy/terms decision. Only then set:

```dotenv
LENS_ADAPTER=scrapling
SCRAPLING_WORKER_MODE=live
GOOGLE_LENS_LIVE_ENABLED=true
GOOGLE_LENS_LIVE_AUTHORIZED=I_UNDERSTAND_AND_AUTHORIZE
```

Run one or a few manually selected synthetic/non-sensitive images first. Stop
on `lens_challenge`, `lens_browser`, unexpected selector output, or any request
from Google to solve a challenge. Never launch a 30/50/100-image live load test
against Google.

## Monitoring

- `/healthz`: process liveness, queue depth, worker count and retained image
  count.
- `/readyz`: authorization/configuration readiness.
- `/metrics`: job terminal counters, cache hits, queue depth and bounded p50,
  p90, p95 and p99 samples for job, queue, browser startup, adapter and
  extraction timings.
- Keep reverse-proxy access logs free of query API keys; prefer headers.
- Alert on queue saturation, dead-letter count, challenge rate, timeout rate,
  memory pressure and retained-image count.

## Rollback

1. Stop routing new RMA recognition work to the self-hosted provider by setting
   the RMA feature flag/provider back to `serpapi_lens` or `mock` according to
   business policy.
2. Preserve the RMA database and private image volumes.
3. Stop the Lens API/worker containers; do not delete Redis or RMA volumes.
4. Restore the previous image/tag and run health checks.
5. Review failed/cancelled jobs before deciding whether to requeue them. Do not
   automatically repeat challenged Google work.
