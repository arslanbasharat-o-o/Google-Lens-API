# Changelog

## [1.0.21] - 2026-10-29

- Fix DOM result selector in modern Google Lens pages: modern Google Lens results omit `<main>` and `[role="main"]` ancestors; updated DOM polling checks and link extraction to match outbound affiliate/store URLs (`a[href^="/goto?url="]`), `a.LBcIee[href]`, and AI mode containers directly. This prevents Scrapling polling from falsely stalling until browser deadline expiration.

## [1.0.20] - 2026-10-29

- Robust worker readiness: make pre-warming of Google entry page opportunistic with 10s timeout, preventing slow residential proxy connections from causing spurious worker restart loops.

## [1.0.19] - 2026-10-29

- Prevent bot detection: remove route abort on images and fonts during Scrapling DOM navigation to preserve authentic canvas and font fingerprinting against Google automated query checks.
- Support modern `aimfl` AI Mode containers: extract rich generative AI identification from `[data-subtree*="aimfl"]`, `div.mZJni`, and `div.n6owBd` containers, extracting complete display model specs and cited supplier links.
- Add `a[href*="udm=50"]` selector to match Google's AI Mode tab navigation links.

## [1.0.18] - 2026-10-29

- Bounded prompt injection: add defensive timeout and immediate one-shot flag to search input filling, preventing hung playwright actions from stalling multisearch requests.

## [1.0.17] - 2026-10-29

- Automated Google consent handling: seamlessly accept Google terms / consent dialogs across regional proxies.
- Dual-tab page preservation: capture full visual matches from the "All" tab and AI specification reasoning from the "AI Mode" tab into the combined snapshot.
- Enhanced AI Mode selectors: wait for generative streaming to complete on AI Mode tabs and parse `AI Mode reply` containers and markdown sections.

## [1.0.16] - 2026-10-29

- Add prompt multisearch support (`prompt` and `q` parameters): callers can now inject targeted text prompts with the uploaded image (e.g. dimensions, Dynamic Island/notch, IC markings) to trigger deep AI reasoning rather than visual guesses.
- Dual-signal extraction: Scrapling worker captures both standard visual matches ("All") and interactive generative AI research ("AI Mode") with full specification text and cited sources into `ai_mode` and `ai_overview`.
- Support seamless AI Mode tab navigation in headless Chrome sessions, polling and waiting for AI generation streaming to complete.
- Propagate `ai_mode` and `ai_overview` through Redis Stream contracts, `LensPageSnapshot`, `DefaultLensParser`, and OpenAPI schemas.

- Install safe route interception in `prepare_dom_navigation` that filters heavy media, image, and font payloads while preserving stylesheets, scripts, and Lens upload endpoints for sub-second page rendering over residential proxies.
- Wrap all route continue and abort invocations in defensive exception handling to eliminate Patchright `Route.continue_` assertion errors during page closure and session rotation.

## [1.0.14] - 2026-10-19

- Fix Patchright `Route.continue_` assertion errors during session disposal and page cancellation by setting `disable_resources: False`, avoiding intrusive route interception while allowing authentic CSS/font metrics to prevent Google bot challenge triggers.
- Increase visual match streaming timeout on the Lens search page from 4.0s to 8.0s before classifying matches as empty, resolving premature empty-result errors over high-latency residential proxies.
- Add safe route cleanup in `prepare_dom_navigation` to guarantee clean page lifecycles during DOM navigation.

## [1.0.13] - 2026-10-19

- Restore recovery through the existing configured proxy: up to three fresh sessions share one total browser deadline. Removing all proxy retries in 1.0.12 reduced recovery from intermittent verification responses.
- Keep active cancellation, stale-session disposal, and DOM-ready navigation. A cancelled caller stops the entire recovery sequence; retry deadlines do not reset per session.

## [1.0.12] - 2026-10-19

- Cancel active browser work when the client cancels or the API attempt expires; retries retain separate cancellation ownership.
- Remove hidden browser/proxy retries inside a dispatch so challenges are returned as failures promptly.
- Use a scoped Scrapling 0.4.15 DOM-ready navigation workaround; an unrelated slow async resource no longer blocks the upload/result hook.
- Verify cancellation and exact attempt isolation with regression tests, and DOM readiness using actual Google Chrome against a controlled local page. Google availability and recognition accuracy require separate live verification.

## [1.0.11] - 2026-10-18

- Fix streaming result race condition: allow progressive visual match cards to hydrate (up to 800ms when resultCount < 8) before returning page snapshot.

## [1.0.10] - 2026-10-18

- Fix challenge handling: instantly fail-fast upon detecting Google verification pages without stalling on Playwright input attachment.
- Fix session leak: ensure `self.close()` runs in `finally` upon any job failure to prevent re-using flagged browser sessions.
- Fast terminal state detection: cleanly detect empty visual match results within 4 seconds instead of waiting for full browser timeout.
- Optimize proxy rotation: remove ad blocking abortion to maintain Google script integrity and lower 429 challenge rates.

## [1.0.9] - 2026-10-18

- Prevent pointer interception error by checking for existing Lens file input before clicking camera icon.
- Increase SEARCH_SYNC_WAIT_MS to 30s to allow graceful session rotation and retries without timing out.
- Configure LENS_CHALLENGE_COOLDOWN_MS in docker-compose.production.yml to prevent 10-minute image lockout.

## [1.0.8] - 2026-10-18

- Remove hardcoded 500ms post-camera click delay in ScraplingLensAdapter.
- Tighten result state polling from 250ms to 50ms for faster match response.
- Enable `block_ads` in Scrapling stealth session to eliminate unnecessary third-party requests and speed up initial page load.
- Scale production deployment to 4 worker replicas with 50ms API polling for high concurrency.

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
