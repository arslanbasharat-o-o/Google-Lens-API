# Recognition provider comparison

Generated from the repository inspection and the offline benchmark on
2026-10-17. This is an evidence report, not a live performance claim.

| Dimension | Existing RMA SerpApi path | New self-hosted service |
| --- | --- | --- |
| Search backend | SerpApi Google Lens API | Real Google Lens website through Playwright when explicitly authorized |
| Upload flow | SerpApi `/image`, then `/search` | Own `/image` or direct upload, then bounded job queue |
| Browser ownership | SerpApi-managed | Own bounded browser/context pool |
| Queue | RMA `pg-boss` recognition worker | In-process bounded queue or optional private Redis queue |
| Cache | SerpApi provider cache behavior | SHA-256 + search-parameter TTL cache with hit metric |
| Failure visibility | Provider error mapped by existing RMA adapter | Per-job queued/running/succeeded/failed/cancelled plus challenge/loading/parser/browser classes |
| RMA changes | Existing provider unchanged | `LENS_PROVIDER=self_hosted_lens` reversible adapter; SerpApi remains available |
| Live evidence in this run | No paid/live request run | No live Google request run |

## Offline concurrency evidence

The local mock adapter used eight bounded workers with a deterministic 2 ms
delay. Every child succeeded without cross-job IDs:

| Batch | Completion (ms) | Succeeded | Failed | RSS after (MiB) |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 2.13 | 1 | 0 | 127.2 |
| 5 | 1.75 | 5 | 0 | 127.9 |
| 10 | 4.56 | 10 | 0 | 129.1 |
| 30 | 9.30 | 30 | 0 | 131.9 |
| 50 | 15.72 | 50 | 0 | 140.0 |
| 100 | 29.93 | 100 | 0 | 156.3 |

These numbers exercise HTTP multipart parsing, queue admission, worker
concurrency, parser normalization and batch aggregation. They do **not** show
Google navigation latency, browser memory, VPS CPU, network bandwidth, result
relevance, CAPTCHA/challenge rate, p50/p95 Google latency, or permission.

## Baseline gap

The repository had no permitted historical SerpApi trace or Hostinger telemetry
available locally. The next authorized measurement should instrument the old
and new paths with the same trace IDs and collect p50/p90/p95/p99, queue wait,
upload, provider, persistence and UI timings. No 2–4 second objective is
declared achieved.
