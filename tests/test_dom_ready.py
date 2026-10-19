import asyncio
import os
from typing import Any

import pytest

from scrapling_worker.dom_ready import DomReadySession, prepare_dom_navigation


@pytest.mark.asyncio
async def test_owned_navigation_defaults_to_dom_ready_without_stacking_wrappers() -> None:
    calls: list[dict[str, Any]] = []

    class Page:
        async def goto(self, url: str, **kwargs: Any) -> str:
            calls.append(kwargs)
            return url

    page = Page()
    await prepare_dom_navigation(page)
    first = page.goto
    await prepare_dom_navigation(page)
    assert page.goto is first
    await page.goto("http://localhost/")
    await page.goto("http://localhost/", wait_until="commit")
    assert calls == [{"wait_until": "domcontentloaded"}, {"wait_until": "commit"}]


@pytest.mark.asyncio
@pytest.mark.skipif(os.getenv("RUN_CHROME_SMOKE") != "1", reason="requires installed Google Chrome")
async def test_slow_async_resource_does_not_block_real_chrome_dom_hooks() -> None:
    slow_started = asyncio.Event()
    release = asyncio.Event()
    handlers: set[asyncio.Task[Any]] = set()

    async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if task:
            handlers.add(task)
        try:
            request = await reader.readuntil(b"\r\n\r\n")
            if request.startswith(b"GET /slow.js "):
                slow_started.set()
                await release.wait()
                body = b"// complete"
            else:
                body = b'<html><head><script async src="/slow.js"></script></head><body>dom-ready-marker</body></html>'
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n" +
                         f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
            await writer.drain()
        finally:
            writer.close()
            if task:
                handlers.discard(task)

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    action_ran = False

    async def action(page: Any) -> None:
        nonlocal action_ran
        assert "dom-ready-marker" in await page.locator("body").inner_text()
        assert not release.is_set()
        action_ran = True

    try:
        port = server.sockets[0].getsockname()[1]
        async with DomReadySession(
            real_chrome=True, headless=True, timeout=1500, load_dom=True,
            network_idle=False, google_search=False, retries=1,
            page_setup=prepare_dom_navigation,
        ) as session:
            page = await session.fetch(f"http://127.0.0.1:{port}/", page_action=action)
        assert action_ran
        assert slow_started.is_set()
        assert "dom-ready-marker" in page.get_all_text()
    finally:
        release.set()
        server.close()
        await server.wait_closed()
        if handlers:
            await asyncio.gather(*handlers, return_exceptions=True)


@pytest.mark.asyncio
async def test_safe_route_handler_absorbs_assertion_errors_and_filters_resources() -> None:
    from scrapling_worker.dom_ready import _safe_route_handler

    class FakeRequest:
        def __init__(self, url: str, resource_type: str) -> None:
            self.url = url
            self.resource_type = resource_type

    class FakeRoute:
        def __init__(self, url: str, resource_type: str, fail_on_continue: bool = False, fail_on_abort: bool = False) -> None:
            self.request = FakeRequest(url, resource_type)
            self.fail_on_continue = fail_on_continue
            self.fail_on_abort = fail_on_abort
            self.aborted = False
            self.continued = False

        async def abort(self) -> None:
            if self.fail_on_abort:
                raise AssertionError("Route.abort: Assertion error")
            self.aborted = True

        async def continue_(self) -> None:
            if self.fail_on_continue:
                raise AssertionError("Route.continue_: Assertion error")
            self.continued = True

    # 1. Image is aborted
    r1 = FakeRoute("https://example.com/logo.png", "image")
    await _safe_route_handler(r1)
    assert r1.aborted is True
    assert r1.continued is False

    # 2. Stylesheet is allowed
    r2 = FakeRoute("https://example.com/style.css", "stylesheet")
    await _safe_route_handler(r2)
    assert r2.aborted is False
    assert r2.continued is True

    # 3. Lens upload url is allowed even if marked image
    r3 = FakeRoute("https://lens.google.com/upload", "image")
    await _safe_route_handler(r3)
    assert r3.aborted is False
    assert r3.continued is True

    # 4. Closed page assertion error on continue_ is safely absorbed
    r4 = FakeRoute("https://example.com/script.js", "script", fail_on_continue=True)
    await _safe_route_handler(r4)
    assert r4.continued is False

    # 5. Closed page assertion error on abort is safely absorbed
    r5 = FakeRoute("https://example.com/font.woff2", "font", fail_on_abort=True)
    await _safe_route_handler(r5)
    assert r5.aborted is False
