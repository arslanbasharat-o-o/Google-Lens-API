# Operations runbook

## Local verification

```sh
cp .env.example .env
npm ci
make check
```

The default adapter is mock, so the check is offline and does not contact
Google or OpenAI. `docker compose --env-file .env config` validates the
Compose interpolation without starting production services.

## Compose deployment

1. Confirm the current image tags and data volumes before adding the service.
   Do not modify existing RMA PostgreSQL or image volumes.
2. Create an owner-only `.env` from `.env.example`; set `API_KEYS` through a
   secret manager and keep `API_AUTH_REQUIRED=true`. The Compose port binds to
   `127.0.0.1` by default; set `API_BIND_ADDRESS=0.0.0.0` only when a TLS and
   authenticated reverse proxy is in front of the service.
3. Select a mode explicitly. The safe deterministic fixture deployment is:

   ```dotenv
   LENS_DEPLOYMENT_MODE=fixture
   SCRAPLING_WORKER_MODE=fixture
   LENS_ADAPTER=scrapling
   ```

   A live deployment must set both mode variables to `live` and provide both
   explicit live authorization gates. If the mode variables disagree, the
   worker exits with a configuration error before publishing a heartbeat.
4. Use `LENS_ADAPTER=scrapling`, `QUEUE_BACKEND=redis`,
   `IMAGE_STORAGE_BACKEND=file`, and the same shared `IMAGE_STORAGE_DIR` in the
   API and worker containers. Validate the rendered configuration before
   starting it:

   ```sh
   docker compose --env-file .env config --quiet
   ```
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
internet without TLS. The API fails at startup if authentication is required
without a key. Once configured, `/readyz` is 503 until Redis responds, the
selected worker publishes a fresh heartbeat, and (for live mode) Google Chrome
passes its startup smoke check.

## Scrapling worker contract

The API publishes to Redis stream `lens:jobs:v1`; the Python worker owns consumer
group `scrapling-workers`. Each message carries `job_id`, `attempt`,
`dispatch_id`, `image_id`, and serialized options, never image bytes. The worker
reads the bare image ID below `IMAGE_STORAGE_DIR` and writes
`lens:result:v1:<job_id>:<attempt>`. Keep the image volume private and mounted at the same
path for both containers. The API's overall poll timeout is controlled by
`SCRAPLING_RESULT_TIMEOUT_MS`.

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

1. Pin the API and worker to their previous image tags.
2. Preserve the RMA database, Redis and private image volumes.
3. Recreate only the Lens API and Scrapling worker containers.
4. Run health checks and review failed/cancelled jobs before deciding whether
   to requeue them. Do not automatically repeat challenged Google work.
