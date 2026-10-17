# Research findings and feasibility gate

Research was performed on 17 October 2026 (Asia/Karachi) against the public
documentation linked below. This is engineering research, not legal advice.

## Sources

- Google Search Help, **Search with an image**:
  <https://support.google.com/websearch/answer/1325808>
- Google Search Help, **Resolve unusual traffic**:
  <https://support.google.com/websearch/answer/86640>
- Google Terms of Service, section **Don't abuse our services**:
  <https://policies.google.com/terms>
- Google `robots.txt`:
  <https://www.google.com/robots.txt>
- SerpApi Google Lens API documentation:
  <https://serpapi.com/google-lens-api>
- SerpApi Image API documentation:
  <https://serpapi.com/image-api>
- Playwright installation and browser isolation documentation:
  <https://playwright.dev/docs/intro> and
  <https://playwright.dev/docs/browser-contexts>

## Confirmed workflow

Google's user instructions describe opening Google, selecting Search by image,
choosing Upload a file, and then reviewing visual results, similar images and
websites. The Playwright adapter follows this visible browser workflow: it
navigates to a configured Google/Lens page, locates a file input or visible
Search by image control, uploads the assigned bytes, waits for observable
result/challenge state, and extracts displayed DOM data. It does not call an
undocumented Lens RPC or private endpoint.

SerpApi's documentation identifies the compatibility parameters that matter to
the RMA integration: `engine=google_lens`, `image_id` or `url`, `type`, `hl`,
`country`, optional `q`, `no_cache`, and `async`. Its documented result fields
include visual matches, exact matches and related content. The local API maps
the fields that are actually observed and leaves absent values absent.

## Compliance and authorization gate

Google's Search Help says automated traffic includes robots, computer programs,
automated services and search scrapers, and describes unusual-traffic
challenges. Google's Terms prohibit abuse, bypassing protective measures and
automated access that violates machine-readable instructions. The public
instructions for using Lens in a browser are not an authorization for a
commercial unattended service.

Therefore:

1. The default adapter is `mock` and makes no Google requests.
2. Live mode requires both `GOOGLE_LENS_LIVE_ENABLED=true` and the exact
   acknowledgment `GOOGLE_LENS_LIVE_AUTHORIZED=I_UNDERSTAND_AND_AUTHORIZE`.
3. The gate is an operational safeguard, not proof that Google has granted
   permission. Obtain written authorization and review applicable Google terms,
   product-specific terms, privacy obligations, and customer consent before
   enabling production traffic.
4. A challenge, CAPTCHA, unusual-traffic page or access denial stops the job.
   There is no automatic aggressive retry, CAPTCHA solving, challenge
   circumvention, proxy rotation, stealth plugin, account farming or
   fingerprint spoofing.
5. `LENS_ADAPTER=scrapling` is a reference-only Redis worker integration. Its
   external worker still requires the same explicit live authorization decision
   before accessing Google; it must not be used as a way to evade restrictions.

No authorized live Google test was run in this workspace. The live-operation-
complete designation therefore remains false.

## Feasibility conclusion

The API, queue, parser, compatibility contract and browser adapter are
technically implementable and are covered by offline tests. Real latency,
selector stability, access approval, Google result relevance and production
throughput cannot be proven without an authorized, bounded live test. The
2–4-second objective is a target for measurement, not a guarantee.
