# Test evidence

Collected on 2026-10-17.

## Standalone service

```text
npm ci --offline --ignore-scripts   passed
npm run typecheck                   passed
npm test                            6 files, 21 tests passed
npm run build                       passed
npm run benchmark:offline           1/5/10/30/50/100 batches completed
git diff --check                    passed
```

Coverage areas include upload signatures/dimensions, API authentication,
idempotency boundaries, cache behavior, batch mapping, parser fixtures,
challenge/loading/empty/parser classification, bounded queue behavior, browser
pool reuse/recycling and SSRF rejection. The suite is offline and does not
launch Chromium or query Google.

## RMA repository

```text
npm test -- --run src/__tests__/unit    16 files, 97 tests passed
npm run typecheck                         passed
npm run lint -- --quiet                   passed
docker compose --env-file .env.example config --quiet  passed
```

The full RMA database integration/e2e suite was not run against production; it
requires an isolated PostgreSQL service and browser test environment. No paid
SerpApi/OpenAI request was made.

## Gaps

- No authorized live Google Lens browser test.
- No Hostinger VPS resource measurement.
- No Docker image build because the local Docker daemon was unavailable when
  the first implementation check ran; rerun `make docker-build` on a host with
  Docker available.
- No vulnerability scanner result is claimed by these tests.
