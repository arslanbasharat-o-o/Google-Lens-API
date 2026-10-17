"""Offline fixture and explicitly gated Scrapling browser adapters."""

from __future__ import annotations

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
    async def search(self, job: StreamJob, image_path: Path) -> LensPageSnapshot: ...

    async def close(self) -> None: ...


class FixturePageAdapter:
    """Deterministic adapter: reads local HTML and never starts a browser."""

    def __init__(self, fixture_dir: Path, default_fixture: str = "success") -> None:
        self.fixture_dir = fixture_dir
        self.default_fixture = default_fixture

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


class FakeFileInput:
    """Small async file-input fake used by adapter tests and examples."""

    def __init__(self, *, visible: bool = True) -> None:
        self.visible = visible
        self.uploaded_path: str | None = None

    async def count(self) -> int:
        return 1

    async def is_visible(self) -> bool:
        return self.visible

    async def set_input_files(self, path: str) -> None:
        self.uploaded_path = path


class FakePage:
    """A deterministic page fake for testing upload behavior without Chromium."""

    def __init__(self, file_input: FakeFileInput | None = None) -> None:
        self.file_input = file_input or FakeFileInput()
        self.clicked = False

    def locator(self, selector: str) -> "FakePageLocator":
        return FakePageLocator(self.file_input)

    def get_by_role(self, role: str, name: object) -> "FakePageButton":
        return FakePageButton(self)


class FakePageLocator:
    def __init__(self, file_input: FakeFileInput) -> None:
        self.first = self
        self.file_input = file_input

    async def count(self) -> int:
        return await self.file_input.count()

    async def is_visible(self) -> bool:
        return await self.file_input.is_visible()

    async def set_input_files(self, path: str) -> None:
        await self.file_input.set_input_files(path)


class FakePageButton:
    def __init__(self, page: FakePage) -> None:
        self.page = page
        self.first = self

    async def count(self) -> int:
        return 1

    async def click(self) -> None:
        self.page.clicked = True


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

    async def search(self, job: StreamJob, image_path: Path) -> LensPageSnapshot:
        if not image_path.is_file():
            raise AdapterError("image_missing", "shared image file does not exist", retryable=False)

        try:
            from scrapling.fetchers import AsyncDynamicSession
        except ImportError as exc:
            raise AdapterError(
                "browser", "Scrapling fetcher dependencies are not installed", retryable=False
            ) from exc

        started = time.monotonic()

        async def page_setup(page: Any) -> None:
            # Kept as an explicit hook: the official API runs this before
            # navigation and it is where only ordinary page listeners belong.
            return None

        async def page_action(page: Any) -> None:
            file_input = await _visible_file_input(page)
            if file_input is None:
                await _open_visible_image_control(page)
                file_input = await _visible_file_input(page)
            if file_input is None:
                raise AdapterError("browser", "the Lens UI did not expose a visible file input", retryable=True)
            await file_input.set_input_files(str(image_path))
            await page.wait_for_function(
                """
                () => {
                  const body = document.body?.innerText ?? '';
                  const challenge = /captcha|recaptcha|verify you are human|unusual traffic|not a robot|robot check/i.test(body);
                  const empty = /no (?:visual )?matches|no results found|couldn['’]t find|try another image|nothing found/i.test(body);
                  const resultCards = document.querySelectorAll(
                    '[data-lens-result], [data-visual-match], [data-result-card], [data-lens-section="visual-matches"] a[href], main a[href], [role="main"] a[href]'
                  );
                  const exactCards = document.querySelectorAll('[data-exact-match], [data-lens-section="exact-matches"] a[href]');
                  const busy = Boolean(document.querySelector('[aria-busy="true"], [role="progressbar"], [data-loading="true"]'));
                  return challenge || empty || resultCards.length > 0 || exactCards.length > 0 || (!busy && body.length > 0);
                }
                """,
                timeout=self.config.browser_timeout_ms,
            )

        try:
            # AsyncDynamicSession, max_pages, page_setup, and page_action are
            # the documented Scrapling 0.4.15 API. No proxy, stealth, account,
            # fingerprint, CAPTCHA, or challenge-bypass option is supplied.
            async with AsyncDynamicSession(
                max_pages=self.config.max_pages,
                headless=self.config.headless,
                timeout=self.config.browser_timeout_ms,
                load_dom=True,
                network_idle=False,
                google_search=False,
                retries=1,
            ) as session:
                page = await session.fetch(
                    self.config.target_url,
                    page_setup=page_setup,
                    page_action=page_action,
                )
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
        return None


async def _visible_file_input(page: Any) -> Any | None:
    locator = page.locator('input[type="file"]')
    count = await locator.count()
    for index in range(count):
        candidate = locator.nth(index) if hasattr(locator, "nth") else locator.first
        if await candidate.is_visible():
            return candidate
    return None


async def _open_visible_image_control(page: Any) -> None:
    control = page.get_by_role("button", name="Search by image")
    if await control.count():
        await control.first.click()
        return
    control = page.locator('[aria-label*="Search by image" i], [aria-label*="Google Lens" i]')
    if await control.count():
        await control.first.click()


def _safe_fixture_name(value: str) -> str:
    if not value or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for character in value):
        raise AdapterError("fixture_invalid", "fixture name contains unsupported characters", retryable=False)
    return value
