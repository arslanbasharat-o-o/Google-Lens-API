# Performance and benchmark evidence

## Measurement model

The service records job latency, queue wait, adapter latency, browser startup,
navigation and result-extraction samples in `/metrics`. A cache hit is counted
separately. The offline benchmark runs the same HTTP multipart and batch paths
for 1, 5, 10, 30, 50 and 100 images with a deterministic mock adapter and
eight bounded workers:

```sh
npm run benchmark:offline
```

It writes `reports/offline-benchmark.json` and prints the same report. The
report records Node version, completion time, successful/failed child counts and
process RSS/heap snapshots. It is a scalability/regression signal for local
queue and parser behavior, not a Google or VPS benchmark.

## Browser pool experiment plan

On the target Linux host, run separate authorized/non-Google mock workloads for
these configurations:

| Experiment | Browser processes | Contexts/process | Worker concurrency |
| --- | ---: | ---: | ---: |
| A | 1 | 1 | 1 |
| B | 1 | 4 | 4 |
| C | 1 | 8 | 8 |
| D | 2 | 4 | 8 |
| E | 2 | 8 | 10 |

Capture container `docker stats`, host `free -h`, `nproc`, disk and network
telemetry, then stop when the RMA service approaches its memory/CPU safety
budget. This repository does not have Hostinger SSH access, so no VPS numbers
or ten-worker claim is made here.

## Acceptance metrics

Record p50/p90/p95/p99 job latency, full-batch completion time, successful jobs
per minute, cache hit ratio, queue wait, browser startup, navigation,
extraction, per-worker memory, peak RAM/CPU, failure/timeout/challenge rates.
Separate mock results from authorized live results. The 2–4 second per-image
goal is not guaranteed: Google navigation, rendering and access decisions are
outside this service's control.

## Baseline gap

The local workspace contains no permitted historical SerpApi latency trace and
no accessible Hostinger runtime telemetry. The original RMA code confirms that
the current path performs an image upload followed by a Google Lens search and
persists the provider result in a `pg-boss` worker, but that is not a measured
baseline. Collect the old provider's request, queue, persistence and UI timing
with trace IDs before switching production traffic.
