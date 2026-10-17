"""Offline fixture and explicitly gated Scrapling browser adapters."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any, Protocol

from scrapling.parser import Selector

from .config import WorkerConfig
from .contract import StreamJob
from .parser import LensPageSnapshot, snapshot_from_page


class AdapterError(RuntimeError):
    """A browser or fixture adapter failure mapped by the worker."""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class PageAdapter(Protocol):
    async def check_ready(self) -> None: ...

    async def search(self, job: StreamJob, image_path: Path) -> LensPageSnapshot: ...

    async def close(self) -> None: ...


class FixturePageAdapter:
    """Deterministic adapter: reads local HTML and never starts a browser."""

    def __init__(self, fixture_dir: Path, default_fixture: str = "success") -> None:
        self.fixture_dir = fixture_dir
        self.default_fixture = default_fixture

    async def check_ready(self) -> None:
        if not self.fixture_dir.is_dir():
            raise AdapterError("fixture_missing", "configured local fixture directory is unavailable", retryable=False)

    async def search(self, job: StreamJob, image_path: Path) -> LensPageSnapshot:
        if not image_path.is_file():
            raise AdapterError("image_missing", "shared image file does not exist", retryable=False)
        fixture_name = _safe_fixture_name(job.fixture or self.default_fixture)
        fixture_path = self.fixture_dir / f"{fixture_name}.html"
        try:
            html = fixture_path.read_bytes()
        except OSError as exc:
            raise AdapterError("fixture_missing", "configured local fixture is unavailable", retryable=False) from exc
        page = Selector(content=html, url=f"fixture://{fixture_name}")
        return snapshot_from_page(page, timings={"adapterMs": 0})

    async def close(self) -> None:
        return None


class ScraplingLensAdapter:
    """Visible DOM adapter backed by Scrapling 0.4.15's async session.

    This class is never constructed by default. The worker factory requires
    both explicit live authorization variables before selecting it.
    """

    def __init__(self, config: WorkerConfig) -> None:
        if not config.live_gate_open:
            raise AdapterError(
                "live_disabled",
                "live Scrapling mode requires both explicit Google Lens authorization gates",
                retryable=False,
            )
        self.config = config
        self._session: Any | None = None

    async def check_ready(self) -> None:
        """Verify installed Google Chrome before publishing the worker heartbeat."""

        from .browser_smoke import check_browser

        try:
            await check_browser(timeout_ms=min(self.config.browser_timeout_ms, 10_000))
            session = await self._ensure_session()
            # Warm Google's Lens entry page before accepting a job. The
            # browser stays open, so the first upload does not pay for a cold
            # Google connection while the API request is waiting.
            await session.fetch(self.config.target_url)
        except AdapterError:
            raise
        except Exception as exc:
            raise AdapterError(
                "browser_unavailable",
                "Google Chrome is unavailable to the Scrapling browser worker",
                retryable=True,
            ) from exc

    async def search(self, job: StreamJob, image_path: Path) -> LensPageSnapshot:
        if not image_path.is_file():
            raise AdapterError("image_missing", "shared image file does not exist", retryable=False)

        started = time.monotonic()
        action_error: AdapterError | None = None
        last_state: dict[str, Any] = {}

        async def page_action(page: Any) -> None:
            nonlocal action_error, last_state
            try:
                # Google also exposes an unrelated AI Mode attachment input.
                # Only the Lens form's encoded_image input performs a visual
                # search; selecting the first generic file input silently
                # leaves the image in an unsent preview.
                lens_input = page.locator('input[type="file"][name="encoded_image"]')
                if await lens_input.count() == 0:
                    await page.get_by_role("button", name="upload a file").click(timeout=5000)
                    await lens_input.wait_for(state="attached", timeout=5000)
                await lens_input.set_input_files(_browser_file_payload(image_path))

                deadline = time.monotonic() + self.config.browser_timeout_ms / 1000
                while time.monotonic() < deadline:
                    try:
                        state = await page.evaluate(
                            """() => {
                              const body = document.body?.innerText ?? '';
                              const searchParams = new URLSearchParams(location.search);
                              const searchResults = location.pathname === '/search' && searchParams.get('udm') === '26';
                              const resultSelector = '[data-lens-result], [data-visual-match], [data-result-card], [data-lens-section="visual-matches"] a[href], [data-exact-match], main a.LBcIee[href], [role="main"] a.LBcIee[href], main a[href^="/goto?url="], [role="main"] a[href^="/goto?url="]';
                              return {
                                path: location.pathname,
                                udm: searchParams.get('udm'),
                                challenge: location.pathname.startsWith('/sorry/') || /captcha|recaptcha|verify you are human|unusual traffic|not a robot|robot check/i.test(body),
                                empty: /no (?:visual )?matches|no results found|couldn['’]t find|try another image|nothing found/i.test(body),
                                resultCount: document.querySelectorAll(resultSelector).length,
                                gotoCount: document.querySelectorAll('main a[href^="/goto?url="], [role="main"] a[href^="/goto?url="]').length,
                                mainLinkCount: document.querySelectorAll('main a[href], [role="main"] a[href]').length,
                                fileInputCount: document.querySelectorAll('input[type="file"][name="encoded_image"]').length,
                                bodyLength: body.length,
                                results: searchResults && document.querySelectorAll(resultSelector).length > 0
                              };
                            }"""
                        )
                        last_state = state
                    except Exception:
                        # Google may replace the document during upload and result navigation.
                        await asyncio.sleep(0.25)
                        continue
                    if state["challenge"]:
                        raise AdapterError("lens_challenge", "Google requested human verification", retryable=False)
                    if state["empty"]:
                        raise AdapterError("lens_empty", "Google returned no visual matches", retryable=False)
                    if state["results"]:
                        return
                    await asyncio.sleep(0.25)
                diagnostic = ", ".join(
                    f"{key}={last_state.get(key)}"
                    for key in ("path", "udm", "resultCount", "gotoCount", "mainLinkCount", "fileInputCount", "bodyLength")
                    if key in last_state
                )
                suffix = f" ({diagnostic})" if diagnostic else ""
                raise AdapterError(
                    "lens_loading",
                    f"the Lens page did not expose a terminal state in time{suffix}",
                    retryable=True,
                )
            except AdapterError as exc:
                # Scrapling logs and suppresses page_action exceptions, so carry
                # the terminal state out of the hook ourselves.
                action_error = exc
            except Exception as exc:
                action_error = AdapterError("lens_browser", "the Lens browser operation failed", retryable=True)

        try:
            # Scrapling owns this Chrome session, including its browser setup.
            # A Google verification page remains a terminal error; this code
            # does not attempt to answer a human challenge.
            session = await self._ensure_session()
            page = await session.fetch(
                self.config.target_url,
                page_action=page_action,
            )
            if action_error is not None:
                raise action_error
            return snapshot_from_page(
                page,
                timings={"adapterMs": int((time.monotonic() - started) * 1000)},
            )
        except AdapterError:
            raise
        except TimeoutError as exc:
            raise AdapterError("lens_loading", "the Lens page did not expose a terminal state in time", retryable=True) from exc
        except Exception as exc:
            raise AdapterError("lens_browser", "the Scrapling browser operation failed", retryable=True) from exc

    async def close(self) -> None:
        if self._session is not None:
            session, self._session = self._session, None
            await session.__aexit__(None, None, None)

    async def _ensure_session(self) -> Any:
        if self._session is None:
            from scrapling.fetchers import AsyncStealthySession

            session = AsyncStealthySession(
                max_pages=self.config.max_pages,
                headless=self.config.headless,
                real_chrome=True,
                timeout=self.config.browser_timeout_ms,
                load_dom=True,
                network_idle=False,
                google_search=False,
                retries=2,
                retry_delay=0,
            )
            await session.__aenter__()
            self._session = session
        return self._session


def _safe_fixture_name(value: str) -> str:
    if not value or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for character in value):
        raise AdapterError("fixture_invalid", "fixture name contains unsupported characters", retryable=False)
    return value


def _browser_file_payload(image_path: Path) -> dict[str, Any]:
    """Give Chrome explicit file metadata for extensionless shared-store images."""

    try:
        image_bytes = image_path.read_bytes()
    except OSError as exc:
        raise AdapterError("image_missing", "shared image file could not be read", retryable=False) from exc

    if image_bytes.startswith(b"\xff\xd8\xff"):
        mime_type, suffix = "image/jpeg", ".jpg"
    elif image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        mime_type, suffix = "image/png", ".png"
    elif len(image_bytes) >= 12 and image_bytes[:4] == b"RIFF" and image_bytes[8:12] == b"WEBP":
        mime_type, suffix = "image/webp", ".webp"
    else:
        raise AdapterError("image_invalid", "shared image format is not a supported browser upload", retryable=False)

    current_suffix = image_path.suffix.lower()
    matching_suffixes = {suffix}
    if mime_type == "image/jpeg":
        matching_suffixes.add(".jpeg")
    filename = image_path.name if current_suffix in matching_suffixes else f"{image_path.name}{suffix}"
    return {"name": filename, "mimeType": mime_type, "buffer": image_bytes}
