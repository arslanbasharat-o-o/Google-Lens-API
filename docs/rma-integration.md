# RMA integration

The sibling RMA repository already has a provider interface at
`src/lib/recognition/lens/types.ts` and selects providers through
`getVisualRecognitionProvider`. Commit
`bd19f12f4179eaceeda762e3bdf8b8ef8785aeca` adds the reversible
`SelfHostedLensProvider` while preserving the existing `serpapi_lens` and
`mock` options.

## Configuration

Set these values in the RMA environment, not in Git:

```dotenv
LENS_PROVIDER=self_hosted_lens
LENS_API_BASE_URL=https://lens-api.example.internal
LENS_API_KEY=<secret>
LENS_API_MODE=upload_search
LENS_TIMEOUT_MS=60000
```

The adapter calls `POST /upload` (an alias of the canonical `/image`) and then
`GET /search?engine=google_lens&image_id=...`. It accepts a direct `/v1/lens/search`
mode when `LENS_API_MODE=direct`. It maps `visual_matches` titles, links,
thumbnails and prices into the existing `VisualIdentificationResult` shape and
uses the RMA's deterministic heuristic cleaner; it does not add an OpenAI call.

## Rollout

1. Keep `LENS_PROVIDER=mock` in CI and local automated checks.
2. Deploy the service with live Google disabled and use the provider contract
   against the mock adapter in a disposable RMA environment.
3. Verify one-image, five-image and 30-image RMA mapping using synthetic data.
4. Back up RMA PostgreSQL and private image storage before changing the feature
   flag.
5. Route a small authorized subset to `self_hosted_lens`; preserve
   `serpapi_lens` as the explicit rollback provider. Do not silently spend
   SerpApi credits or OpenAI credits during tests.
6. Compare recognition run IDs, item IDs, candidate ranks, review states,
   timeout/challenge errors and end-user rendering before expanding traffic.

## Fields consumed by RMA

The current processor persists each returned candidate's `title`, `link` and
rank as `recognition_candidates`. Synthesis uses the candidate titles and the
provider's normalized manufacturer/model fields. Raw compatibility JSON is
stored on the visual recognition run for audit. The RMA UI does not require
`serpapi.com` URLs; the new service emits Google/source URLs only when observed.
