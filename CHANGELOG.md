# Changelog

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
