# Security and data protection review

## Data flow and privacy

Uploaded images can contain customer information. In live mode, the bytes are
sent to Google Lens; the RMA owner must obtain the necessary customer notice,
consent, contractual permission and cross-border processing assessment before
enabling it. The service does not write image bytes to application logs.

Development uses an in-memory image store with a configurable TTL and bounded
record count. Production `FileImageStore` writes each validated image beneath
`IMAGE_STORAGE_DIR` using generated IDs, atomic same-directory renames, JSON
metadata, integrity checks, and retention/max-record cleanup. Jobs release
their in-process byte buffers on terminal state; the external Scrapling worker
receives only the image reference.

## Controls implemented

- API key authentication with bearer or `X-API-Key` support.
- Timing-safe key comparison, hashed principal fingerprints, and an in-memory
  per-principal/IP rate limiter.
- Job, batch, image, idempotency, and result-cache namespaces are scoped to the
  authenticated principal. Query-string API keys are rejected unless the
  explicit `ALLOW_QUERY_API_KEY` migration flag is enabled.
- Multipart file, field, part, byte and batch limits.
- JPEG/PNG/WebP magic-byte verification; declared MIME mismatch rejection.
- Header-only dimension and pixel-count checks to reduce decompression-bomb risk.
- Filename basename sanitization; filenames are not used as filesystem paths.
- SHA-256 cache keys include all result-affecting search options.
- Short image retention and bounded job/cache stores.
- File image metadata/data are private to `IMAGE_STORAGE_DIR`; deletion accepts
  UUID IDs only and rejects path traversal. Redis persistence stores metadata
  and results without image bytes.
- SSRF controls for remote URLs: HTTP(S) only, no credentials, manual redirect
  validation, DNS resolution, private/link-local/metadata range blocking,
  IPv4-mapped IPv6 handling, pinned validated addresses for each HTTP request,
  response-size and timeout limits.
- Aggregate multipart image-byte admission (`MAX_BATCH_BYTES`) prevents a
  batch from retaining `MAX_BATCH_SIZE` full-size images in process memory.
- Cooperative cancellation, bounded retries and dead-letter metadata.
- The Fastify process owns no browser; the separate worker uses a bounded
  Scrapling session and stores no persistent personal Google profile or cookies.
- Container runs as the Node user with dropped capabilities, no-new-privileges,
  read-only root filesystem, bounded `/tmp`, private Redis network and resource
  limits in Compose.

## Controls deliberately not implemented

No CAPTCHA solving, challenge bypass, stealth or anti-detection plugin, proxy
rotation to evade restrictions, account farming, browser fingerprint spoofing,
or undocumented authentication bypass is present. These are not acceptable
reliability mechanisms and would conflict with the stated compliance gate.

## Residual risks

1. Redis persistence and a shared file image volume are required for restart
   safe multi-replica Scrapling operation; a memory backend remains intentionally
   process-local for offline tests.
2. The remote fetcher pins each request to the address returned by its
   validation lookup, including every redirect. A deployment egress policy or
   DNS firewall is still recommended as defense in depth, especially where
   transparent proxies or custom network agents are introduced.
3. TLS is expected at the existing reverse proxy; do not expose the API or
   Redis directly to the public internet.
4. Dependency and container scanning must run in CI/deployment. The local
   checks do not prove a clean vulnerability report.
5. Google may change selectors or deny access. Such cases are classified and
    surfaced, not hidden behind empty successful results.
