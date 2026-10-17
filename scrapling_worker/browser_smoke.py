"""Offline Google Chrome smoke check used by live-worker readiness."""

from __future__ import annotations

import asyncio


SMOKE_MARKER = "scrapling-browser-smoke-ok"


async def check_browser(*, timeout_ms: int = 5000) -> None:
    """Launch installed Google Chrome and render a loopback page."""

    try:
        from scrapling.fetchers import AsyncStealthySession
    except ImportError as exc:  # pragma: no cover - dependency is locked in the image
        raise RuntimeError("Scrapling browser dependencies are not installed") from exc

    document = f"<html><body>{SMOKE_MARKER}</body></html>".encode()

    async def serve_once(_reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
            + f"Content-Length: {len(document)}\r\nConnection: close\r\n\r\n".encode()
            + document
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(serve_once, "127.0.0.1", 0)
    try:
        port = server.sockets[0].getsockname()[1]
        async with AsyncStealthySession(
            max_pages=1,
            headless=True,
            real_chrome=True,
            timeout=timeout_ms,
            load_dom=True,
            network_idle=False,
            google_search=False,
            retries=1,
        ) as session:
            page = await session.fetch(f"http://127.0.0.1:{port}/")
    finally:
        server.close()
        await server.wait_closed()
    body = str(page.get_all_text(separator=" ", strip=True))
    if SMOKE_MARKER not in body:
        raise RuntimeError("Google Chrome smoke page did not render its marker")


def main() -> None:
    asyncio.run(check_browser())


if __name__ == "__main__":
    main()
