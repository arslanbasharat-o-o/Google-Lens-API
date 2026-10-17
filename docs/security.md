# Security and data protection review

## Data flow and privacy

Uploaded images can contain customer information. In live mode, the bytes are
sent to Google Lens; the RMA owner must obtain the necessary customer notice,
consent, contractual permission and cross-border processing assessment before
enabling it. The service does not write image bytes to application logs.

The current image store is in memory with a configurable TTL and bounded record
count. Jobs release their byte buffers on terminal state. A production
deployment should use encrypted-at-rest temporary storage if the process needs
to survive restarts, and should define a deletion/backup policy that covers
those bytes.

## Controls implemented

- API key authentication with bearer or `X-API-Key` support.
- Timing-safe key comparison and an in-memory per-principal/IP rate limiter.
- Multipart file, field, part, byte and batch limits.
- JPEG/PNG/WebP magic-byte verification; declared MIME mismatch rejection.
- Header-only dimension and pixel-count checks to reduce decompression-bomb risk.
- Filename basename sanitization; filenames are not used as filesystem paths.
- SHA-256 cache keys include all result-affecting search options.
- Short image retention and bounded job/cache stores.
- SSRF controls for remote URLs: HTTP(S) only, no credentials, manual redirect
  validation, DNS resolution, private/link-local/metadata range blocking,
  response-size and timeout limits.
- Cooperative cancellation, bounded retries and dead-letter metadata.
- Browser contexts are isolated per job; no persistent personal Google profile
  or cookies are stored.
- Container runs as the Node user with dropped capabilities, no-new-privileges,
  read-only root filesystem, bounded `/tmp`, private Redis network and resource
  limits in Compose.

## Controls deliberately not implemented

No CAPTCHA solving, challenge bypass, stealth or anti-detection plugin, proxy
rotation to evade restrictions, account farming, browser fingerprint spoofing,
or undocumented authentication bypass is present. These are not acceptable
reliability mechanisms and would conflict with the stated compliance gate.

## Residual risks

1. A process-local job/status store is not restart-safe across replicas. Add a
   durable, encrypted JobStore before horizontal scaling.
2. DNS validation and a subsequent normal HTTP client request can still be
   exposed to DNS rebinding without a network egress proxy or pinned resolver.
   Keep the API egress policy restrictive and test it on the deployment host.
3. TLS is expected at the existing reverse proxy; do not expose the API or
   Redis directly to the public internet.
4. Dependency and container scanning must run in CI/deployment. The local
   checks do not prove a clean vulnerability report.
5. Google may change selectors or deny access. Such cases are classified and
   surfaced, not hidden behind empty successful results.
