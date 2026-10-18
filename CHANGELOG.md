# Changelog

## [1.0.7] - 2026-10-18

- Add automatic proxy session rotation retry on Google Lens challenge within Scrapling worker.
- Retry search once with a fresh residential/mobile IP and browser context before reporting failure.
- Ensure type-safe return and error handling in search loop.

## [1.0.6] - 2026-10-18

- Increase the Redis pending-job reclaim window so a live Lens search is not
  reclaimed and submitted a second time while its browser call is still active.
- Reject worker configurations whose reclaim window is shorter than the browser
  timeout plus a 30-second margin.
- Use first-writer-wins Redis result storage so a late duplicate cannot overwrite
  a completed result with a stale challenge or timeout.
- Validate reclaim safety and concurrent duplicate completion with offline tests.

## [1.0.5] - 2026-10-18

- Honor `no_cache` flag and allow bypassing challenge cooldown lockouts.
- Support disabling or tuning challenge cooldown (`LENS_CHALLENGE_COOLDOWN_MS <= 0`).

## [1.0.4] - 2026-10-18

- Add dynamic residential proxy session rotation (`rotate_proxy_session`) for AnyIP
  and sticky session proxies.
- Automatically flag and close challenged browser sessions, acquiring a clean residential
  IP from the proxy pool on the subsequent search request.
- Keep session stickiness throughout individual visual search queries to prevent IP/token mismatch.

## [1.0.3] - 2026-10-18

- Click the Google camera button (`[aria-label="Search by image"]`) before querying
  for the Lens file input, accommodating modern Google Search landing pages.
- Handle fallback upload button clicks smoothly with existence checks.

## [1.0.2] - 2026-10-18

- Add residential/mobile proxy support (`SCRAPLING_PROXY_URL`) with automatic
  Playwright/Chromium normalization and sanitization.
- Enable Scrapling stealth evasion settings for Google (`google_search=True`,
  `disable_resources=True`, `block_webrtc=True`).
- Add challenge cooldown suppression to pause repeated automated queries for
  exact images that triggered a Google human-verification challenge.
- Tune production timeouts for mobile proxy latency: browser timeout (35s) and
  result timeout (40s).

## [1.0.1] - 2026-10-18

- Include optional, bounded `ai_overview` text only when an explicit Google AI
  Overview heading and adjacent answer text are present.
- Keep the overview separate from visual listings and document that it is
  supporting evidence rather than a verified model identification.
- Preserve challenge-aware behavior: no challenge bypass, retry loop, or paid
  AI request was added.
- Validate parser behavior with offline fixtures.

## [1.0.0] - 2026-10-17

- Publish the standalone Google Lens API and Scrapling Chrome worker.
- Add bounded, durable Redis-backed processing, per-principal job isolation,
  upload and remote-image protections, and challenge-aware failure reporting.
- Keep all automated tests offline; live Google Lens checks require an explicit
  operational decision.
