# Connect the RMA system

RMA sends images to this authenticated API through its private Docker network.
The service returns observed visual matches; RMA scores up to 30 ranked matches
and stores them with the source URL and rank so staff can review uncertain
model suggestions.

## Environment

Keep credentials in the untracked RMA `.env` file. Use the same private key in
the RMA worker and Lens API:

```dotenv
LENS_PROVIDER=self_hosted_lens
LENS_API_BASE_URL=http://lens-api:3000
LENS_API_KEY=<private shared service key>
LENS_API_MODE=upload_search
LENS_API_POLL_INTERVAL_MS=250
LENS_API_IMAGE=ghcr.io/arslanbasharat-o-o/google-lens-api:1.0.14
LENS_WORKER_IMAGE=ghcr.io/arslanbasharat-o-o/google-lens-scrapling-worker:1.0.14
RMA_DOCKER_NETWORK=rma-system_rma_network
```

The upload/search contract calls `POST /upload`, then
`GET /search?image_id=...`. The normalized `visual_matches` result carries only
source details observed by Google Lens. This service does not call OpenAI.

## Deployment checks

1. Keep test suites on the mock provider. They must not call the live Lens API
   or any paid service.
2. Start the API stack from `docker-compose.production.yml` and confirm
   `/readyz` reports the API and Scrapling worker ready.
3. Confirm the RMA app and worker use the same API key and image release.
4. Verify HTTPS and RMA health, then inspect a small, approved real image set.
5. Review result counts, candidate ranks, ambiguous states, timeouts and
   challenge errors before increasing image volume.

Google verification pages are terminal failures; the worker does not bypass
them or retry aggressively. Review uncertain model matches before confirming
them in RMA.
