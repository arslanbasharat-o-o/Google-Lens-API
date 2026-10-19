# Standalone Google Lens Search API & Scrapling Chrome Worker

[![CI](https://img.shields.io/github/actions/workflow/status/arslanbasharat-o-o/Google-Lens-API/ci.yml?branch=main&label=CI)](https://github.com/arslanbasharat-o-o/Google-Lens-API/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/arslanbasharat-o-o/Google-Lens-API?label=Release&color=2ea44f)](https://github.com/arslanbasharat-o-o/Google-Lens-API/releases/latest)
[![Fastify](https://img.shields.io/badge/Fastify-5.12-000000?logo=fastify&logoColor=white)](https://fastify.dev)
[![Node.js](https://img.shields.io/badge/Node.js-22_LTS-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Python](https://img.shields.io/badge/Python-3.12_uv-3776AB?logo=python&logoColor=white)](https://docs.astral.sh/uv/)
[![Redis Streams](https://img.shields.io/badge/Queue-Redis_Streams-DC382D?logo=redis&logoColor=white)](https://redis.io)
[![Browser](https://img.shields.io/badge/Browser-Google_Chrome_Headless-4285F4?logo=google-chrome&logoColor=white)](https://www.google.com/chrome/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An enterprise-grade, high-throughput reverse image search microservice powered by **Google Lens**, **Scrapling**, and **Redis Streams**. Engineered specifically for visual inspection workflows, hardware identification, and catalog reconciliation without relying on unstable third-party scrapers.

---

## Highlights

- **Stealth Browser Automation**: Operates via Scrapling's `AsyncStealthySession` driving real Google Chrome with anti-detection flags (`block_webrtc`, `disable_resources`, `google_search=True`).
- **Residential & Mobile Proxy Rotation**: Out-of-the-box support for authenticated residential proxy pools (AnyIP, BrightData, Oxylabs) with sticky sessions (`sesstime_30`) during multi-step image uploads and automated session rotation on challenges.
- **Durable Redis Streams Architecture**: Fully decoupled TypeScript API gateway and Python browser worker connected via `lens:jobs:v1` stream with consumer groups, claim safety windows, and atomic compare-and-set persistence.
- **Sub-Second Offline Testability**: Zero dependency on live browser runs during CI/CD. Ships with offline mock adapters, fixture-tested DOM parsers, and fake Redis backends.
- **SSRF & Binary Validation Protection**: Strict image MIME sniffers (JPEG, PNG, WebP), dimension bounds, cryptographic SHA-256 hashing, and automated link-local/private subnet SSRF blocking.
- **Enterprise Batch Processing**: Inspect up to 30 images concurrently per request with aggregate progress tracking, failure isolation, and circuit breakers.

---

## System Architecture

```mermaid
flowchart TD
    Client[Client App / RMA System] -->|POST /search.json or /v1/lens/batch| API[Fastify API Gateway<br/>TypeScript]

    subgraph Ingestion & Validation
        API --> Val[MIME & Magic Bytes Sniffer]
        Val --> SSRF[SSRF & IPv6 Private Range Blocker]
        SSRF --> Store[(Atomic Image Store<br/>15-min TTL)]
    end

    subgraph Durable Queue Boundary
        Store --> Stream[(Redis Streams<br/>lens:jobs:v1)]
        Stream --> Group[Consumer Group: scrapling-workers]
    end

    subgraph Browser Execution Worker
        Group --> Worker[Scrapling Python Worker]
        Worker --> Proxy[Residential Proxy Manager<br/>AnyIP / BrightData Pool]
        Proxy --> Chrome[Google Chrome Stealth Session<br/>AsyncStealthySession]
        Chrome --> Google[Google Lens Web Endpoint]
    end

    subgraph Response & Caching
        Google --> Result[(Redis Result Key<br/>lens:result:v1:job_id)]
        Result --> Parser[Structured DOM Parser]
        Parser --> Cache[(SHA-256 TTL Cache)]
        Cache --> API
    end
```

---

## Performance & Reliability Controls

| Mechanism | Description | Default Configuration |
| :--- | :--- | :--- |
| **Pending Job Reclaim** | Guarantees that active browser operations are not re-assigned mid-flight. | `LENS_RECLAIM_IDLE_MS=120000` (2 minutes) |
| **Browser Timeout** | Bounded deadline for file injection, search redirection, and DOM rendering. | `SCRAPLING_BROWSER_TIMEOUT_MS=15000` (15s) |
| **Challenge Cooldown** | In-memory circuit breaker that suppresses repeated requests for challenged images. | `LENS_CHALLENGE_COOLDOWN_MS=600000` (10m) |
| **Proxy Auto-Rotation** | Rotates proxy session token (`rotate_proxy_session`) if Google issues human verification. | Enabled for residential proxies |
| **Image Retention** | Automatic filesystem pruning of transient image uploads to prevent storage leaks. | Max 15 minutes TTL |

---

## REST API Reference

All production endpoints require authentication via `Authorization: Bearer <token>` or `X-API-Key: <token>`.

### 1. Single Image Visual Search

`POST /search.json` (aliases: `/search`, `/v1/search`, `/v1/lens/search`)

Execute a direct multipart image search. If completed within `SEARCH_SYNC_WAIT_MS` (default 30s), returns `200 OK`. If the job is still processing, returns `202 Accepted` with a job tracking URL.

```bash
curl -X POST "https://lens.example.com/search.json?engine=google_lens&type=visual_matches" \
  -H "Authorization: Bearer $API_KEY" \
  -F "image=@./inspection_display.png"
```

#### Response Payload (`200 OK`)

```json
{
  "search_metadata": {
    "id": "c1f7a08b-b816-47b2-a42e-13c23948e581",
    "status": "Success",
    "json_endpoint": "/v1/jobs/c1f7a08b-b816-47b2-a42e-13c23948e581",
    "cached": false,
    "source": "scrapling"
  },
  "search_parameters": {
    "engine": "google_lens",
    "type": "visual_matches"
  },
  "ai_overview": "iPhone 15 Pro Max OLED display assembly with Dynamic Island cutouts and ceramic shield glass.",
  "visual_matches": [
    {
      "position": 1,
      "title": "OEM iPhone 15 Pro Max Screen Replacement OLED",
      "link": "https://example.com/item/15-pro-max-screen",
      "source": "example.com",
      "thumbnail": "https://example.com/thumb/15-pm.jpg"
    },
    {
      "position": 2,
      "title": "Apple iPhone 15 Pro Max Display Assembly with Flex Cable",
      "link": "https://repairs.example.com/parts/apple/iphone-15-pm",
      "source": "repairs.example.com",
      "thumbnail": "https://repairs.example.com/thumb/flex.jpg"
    }
  ]
}
```

### 2. Two-Phase Upload & Search

Ideal for distributed architectures where upload ingestion and search triggering occur at different steps.

```bash
# Step 1: Upload image to secure image store
IMAGE_ID=$(curl -s -F "image=@./display.png" -H "Authorization: Bearer $API_KEY" https://lens.example.com/upload | jq -r .image_id)

# Step 2: Query visual matches using the allocated image_id
curl -s -H "Authorization: Bearer $API_KEY" "https://lens.example.com/search.json?engine=google_lens&image_id=${IMAGE_ID}&type=all"
```

### 3. Concurrent Batch Processing

`POST /v1/lens/batch` (alias: `/v1/batches`)

Submit up to `MAX_BATCH_SIZE` (default 30) images in a single multipart request.

```bash
curl -X POST "https://lens.example.com/v1/lens/batch?engine=google_lens&type=visual_matches" \
  -H "Authorization: Bearer $API_KEY" \
  -F "image=@./screen_01.png" \
  -F "image=@./screen_02.png" \
  -F "image=@./screen_03.png"
```

Poll batch status with `GET /v1/lens/batch/:batchId`:

```json
{
  "batch_id": "batch-8f92134c",
  "status": "completed",
  "total": 3,
  "succeeded": 3,
  "failed": 0,
  "jobs": [
    { "job_id": "job-001", "status": "succeeded", "result_url": "/v1/jobs/job-001" },
    { "job_id": "job-002", "status": "succeeded", "result_url": "/v1/jobs/job-002" },
    { "job_id": "job-003", "status": "succeeded", "result_url": "/v1/jobs/job-003" }
  ]
}
```

### 4. Operational & Observability Probes

- `GET /healthz` — Basic liveness probe (HTTP 200).
- `GET /readyz` — Readiness probe; checks Redis connection, worker heartbeat freshness, and Chrome browser availability.
- `GET /metrics` — Prometheus metrics export (scrape duration, queue depth, cache hit ratio, proxy retry counts).
- `GET /openapi.json` — Complete OpenAPI 3.0 specification.

---

## Residential Proxy Setup & Stealth Controls

Google Lens applies advanced anti-bot heuristics against public cloud providers. Configure a residential proxy via `SCRAPLING_PROXY_URL`:

```dotenv
# Supported Formats:
# 1. URI format:
SCRAPLING_PROXY_URL=http://user-res:pass@proxy.anyip.io:1080

# 2. Host:Port:User:Pass format:
SCRAPLING_PROXY_URL=proxy.anyip.io:1080:user-res:pass
```

### Sticky Session Handshake
Uploading an image requires navigating to Google, clicking the camera upload button, injecting the binary payload, and handling redirect hops. The worker enforces a sticky session (`sesstime_30`) throughout this sequence to prevent IP switches mid-upload.

### Challenge Auto-Rotation
When a Google verification prompt (CAPTCHA / Robot Check) is detected:
1. The worker dynamically generates a new session identifier.
2. The proxy gateway assigns a clean residential IP from the pool.
3. The worker retries the upload cleanly up to 3 times before returning an explicit, classified error.

---

## Quickstart

### Prerequisites

- **Node.js**: `22.14.0` (pinned in `.nvmrc`)
- **Python**: `3.12.4` and `uv` (pinned in `.python-version` and `uv.lock`)
- **Docker & Compose**: (optional, for containerized run)

### Local Offline Development

```bash
# Clone the repository
git clone https://github.com/arslanbasharat-o-o/Google-Lens-API.git
cd Google-Lens-API

# Install Node dependencies
nvm use
npm ci

# Install Python worker dependencies
uv sync --locked --extra dev

# Run comprehensive offline test suite
make check

# Start API in offline mock mode
API_AUTH_REQUIRED=false LENS_ADAPTER=mock QUEUE_BACKEND=memory npm start
```

---

## Docker & Production Deployment

Production uses `docker-compose.production.yml`, running the TypeScript Fastify API, Redis, and Python Scrapling worker as isolated services on a private Docker bridge.

```bash
# 1. Configure production environment
cp .env.example .env
chmod 600 .env

# 2. Start the production stack
docker compose -f docker-compose.production.yml up -d
```

### Published Container Images

Published automatically to GitHub Container Registry (GHCR) upon release tags:

| Container | Purpose | Version Tag | Latest Tag |
| :--- | :--- | :--- | :--- |
| `ghcr.io/arslanbasharat-o-o/google-lens-api` | Fastify API Gateway | `1.0.13` | `latest` |
| `ghcr.io/arslanbasharat-o-o/google-lens-scrapling-worker` | Scrapling + Chrome Worker | `1.0.13` | `latest` |

---

## Verification & Test Commands

```bash
# Run TypeScript offline unit tests
npm test

# Run Python Scrapling offline tests
uv run pytest -q

# Run static type checks
npm run typecheck
uv run mypy scrapling_worker

# Verify lockfile integrity
uv lock --check

# Run offline benchmark
npm run benchmark:offline
```

---

## Documentation

- [`docs/api.md`](docs/api.md) — Comprehensive API specifications, response schemas, and error codes.
- [`docs/architecture.md`](docs/architecture.md) — Redis Streams queue dynamics, worker lifecycle, and data boundaries.
- [`docs/scrapling-worker.md`](docs/scrapling-worker.md) — In-depth Scrapling stealth session implementation and DOM readiness.
- [`docs/operations.md`](docs/operations.md) — Runbooks for deployment, log analysis, proxy debugging, and rollbacks.
- [`docs/rma-integration.md`](docs/rma-integration.md) — Integration guide for connecting with the RMA System.
- [`docs/security.md`](docs/security.md) — SSRF protection, secret handling, and container hardening.

---

## License

This project is licensed under the [MIT License](LICENSE).
