# Changelog

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
