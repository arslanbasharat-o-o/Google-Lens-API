"""Scoped compatibility for Scrapling 0.4.15's unconditional load wait.

Lens is an interactive page: an unrelated async resource must not prevent the
upload/result DOM hooks from running. Keep this workaround inside our owned
session; never patch the installed package or another Chrome session.
"""

from typing import Any

from scrapling.fetchers import AsyncStealthySession


async def prepare_dom_navigation(page: Any) -> None:
    """Use DOMContentLoaded for the initial navigation made by Scrapling."""
    if getattr(page, "_lens_dom_navigation", False):
        return
    if hasattr(page, "unroute_all"):
        try:
            await page.unroute_all(behavior="ignoreErrors")
        except Exception:
            pass
    original_goto = page.goto

    async def goto(url: str, **kwargs: Any) -> Any:
        kwargs.setdefault("wait_until", "domcontentloaded")
        return await original_goto(url, **kwargs)

    page.goto = goto
    page._lens_dom_navigation = True


class DomReadySession(AsyncStealthySession):
    async def _wait_for_page_stability(self, page: Any, load_dom: bool, network_idle: bool) -> None:
        # 0.4.15 waits for `load` even with network_idle=False. Our explicit
        # page_action checks the upload/result DOM before returning a result.
        if load_dom:
            await page.wait_for_load_state(state="domcontentloaded")
        if network_idle:
            await self._wait_for_networkidle(page)
