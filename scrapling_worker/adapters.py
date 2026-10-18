"""Offline fixture and explicitly gated Scrapling browser adapters."""

from __future__ import annotations

import asyncio
import re
import secrets
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
                page_url = getattr(page, "url", "")
                if "/sorry/" in page_url or "captcha" in page_url:
                    raise AdapterError("lens_challenge", "Google requested human verification", retryable=False)

                lens_input = page.locator('input[type="file"][name="encoded_image"]')
                if await lens_input.count() == 0:
                    camera = page.locator('[aria-label="Search by image"]')
                    if await camera.count() > 0:
                        try:
                            await camera.click(timeout=2000)
                        except Exception:
                            pass

                if await lens_input.count() == 0:
                    upload_btn = page.get_by_role("button", name="upload a file")
                    try:
                        if await upload_btn.count() > 0:
                            await upload_btn.click(timeout=1500)
                    except Exception:
                        pass
                    try:
                        await lens_input.wait_for(state="attached", timeout=2000)
                    except Exception:
                        pass

                if await lens_input.count() == 0:
                    page_url = getattr(page, "url", "")
                    if "/sorry/" in page_url or "captcha" in page_url:
                        raise AdapterError("lens_challenge", "Google requested human verification", retryable=False)
                    raise AdapterError("lens_loading", "Lens upload input not found on page", retryable=True)

                await lens_input.set_input_files(_browser_file_payload(image_path), timeout=5000)

                deadline = time.monotonic() + self.config.browser_timeout_ms / 1000
                search_page_seen_at = None
                first_result_seen_at = None
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
                                onSearchPage: searchResults,
                                results: searchResults && document.querySelectorAll(resultSelector).length > 0
                              };
                            }"""
                        )
                        last_state = state
                    except Exception:
                        # Google may replace the document during upload and result navigation.
                        await asyncio.sleep(0.05)
                        continue
                    if state["challenge"]:
                        raise AdapterError("lens_challenge", "Google requested human verification", retryable=False)
                    if state["empty"]:
                        raise AdapterError("lens_empty", "Google returned no visual matches", retryable=False)
                    if state["results"]:
                        count = state.get("resultCount", 0)
                        if not count or count >= 8:
                            return
                        if first_result_seen_at is None:
                            first_result_seen_at = time.monotonic()
                        elif time.monotonic() - first_result_seen_at >= 0.8:
                            return
                    if state.get("onSearchPage"):
                        if search_page_seen_at is None:
                            search_page_seen_at = time.monotonic()
                        elif time.monotonic() - search_page_seen_at > 4.0:
                            raise AdapterError("lens_empty", "Google returned no visual matches", retryable=False)
                    await asyncio.sleep(0.05)
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

        max_attempts = 3 if self.config.proxy_url else 1
        for attempt_idx in range(max_attempts):
            action_error = None
            last_state = {}
            try:
                # Scrapling owns this Chrome session, including its browser setup.
                # A Google verification page triggers session rotation when backed by a proxy.
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
            except AdapterError as exc:
                if exc.code == "lens_challenge":
                    self._flagged_challenge = True
                    if attempt_idx < max_attempts - 1 and self.config.proxy_url:
                        await self.close()
                        self._flagged_challenge = False
                        continue
                elif exc.retryable and attempt_idx < max_attempts - 1 and self.config.proxy_url:
                    await self.close()
                    continue
                raise
            except TimeoutError as exc:
                if attempt_idx < max_attempts - 1 and self.config.proxy_url:
                    self._flagged_challenge = True
                    await self.close()
                    self._flagged_challenge = False
                    continue
                raise AdapterError("lens_loading", "the Lens page did not expose a terminal state in time", retryable=True) from exc
            except Exception as exc:
                if attempt_idx < max_attempts - 1 and self.config.proxy_url:
                    self._flagged_challenge = True
                    await self.close()
                    self._flagged_challenge = False
                    continue
                raise AdapterError("lens_browser", "the Scrapling browser operation failed", retryable=True) from exc
        raise AdapterError("lens_browser", "the Scrapling browser operation failed after retries", retryable=True)

    async def close(self) -> None:
        if self._session is not None:
            session, self._session = self._session, None
            await session.__aexit__(None, None, None)

    async def _ensure_session(self) -> Any:
        if self._session is not None and getattr(self, "_flagged_challenge", False):
            await self.close()
            self._flagged_challenge = False

        if self._session is None:
            from scrapling.fetchers import AsyncStealthySession

            session_kwargs: dict[str, Any] = {
                "max_pages": self.config.max_pages,
                "headless": self.config.headless,
                "real_chrome": True,
                "timeout": self.config.browser_timeout_ms,
                "load_dom": True,
                "network_idle": False,
                "google_search": True,
                "disable_resources": True,
                "block_webrtc": True,
                "retries": 1,
                "retry_delay": 0,
            }
            if self.config.proxy_url:
                session_kwargs["proxy"] = rotate_proxy_session(self.config.proxy_url)

            session = AsyncStealthySession(**session_kwargs)
            await session.__aenter__()
            self._session = session
        return self._session


def rotate_proxy_session(proxy_url: str | None) -> str | None:
    """Rotate session token for sticky residential/mobile proxies (e.g. AnyIP).

    Google Lens flags IPs that make repetitive automated search requests.
    Rotating the session parameter connects to a fresh, clean residential IP
    while preserving sticky session during each individual search.
    """
    if not proxy_url:
        return None
    token = secrets.token_hex(5)
    if "session_" in proxy_url:
        return re.sub(r"session_[a-zA-Z0-9_-]+", f"session_{token}", proxy_url)
    if "anyip.io" in proxy_url:
        return re.sub(r":([^:@]+)@(portal\.anyip\.io|[^:]+:\d+)", rf",session_{token}:\1@\2", proxy_url)
    return proxy_url


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
