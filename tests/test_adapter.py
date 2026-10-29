import asyncio
from pathlib import Path
from typing import Any

import pytest
from scrapling.parser import Selector

from scrapling_worker.adapters import AdapterError, ScraplingLensAdapter
from scrapling_worker.config import WorkerConfig
from scrapling_worker.contract import SearchOptions, StreamJob


def _live_config() -> WorkerConfig:
    return WorkerConfig(mode="live", live_enabled=True, live_authorized=True, browser_timeout_ms=1000)


class FakeLensInput:
    def __init__(self) -> None:
        self.uploaded_file: dict[str, Any] | None = None

    async def count(self) -> int:
        return 1

    async def set_input_files(self, file_payload: dict[str, Any], *args: Any, **kwargs: Any) -> None:
        self.uploaded_file = file_payload


class FakeElement:
    def __init__(self) -> None:
        self.first = self

    async def count(self) -> int:
        return 0

    async def click(self, **kwargs: Any) -> None:
        return None

    async def fill(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def press(self, *args: Any, **kwargs: Any) -> None:
        return None


class FakePage:
    def __init__(self, state: dict[str, bool]) -> None:
        self.state = state
        self.lens_input = FakeLensInput()

    def locator(self, selector: str) -> Any:
        if selector == 'input[type="file"][name="encoded_image"]':
            return self.lens_input
        return FakeElement()

    async def evaluate(self, _script: str) -> dict[str, bool]:
        return self.state

    async def content(self) -> str:
        return ""


class FakeStealthySession:
    instances: list["FakeStealthySession"] = []

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.instances.append(self)
        self.page = FakePage({"challenge": True, "empty": False, "results": False})

    async def __aenter__(self) -> "FakeStealthySession":
        return self

    async def __aexit__(self, *_args: Any) -> None:
        return None

    async def fetch(self, _url: str, *, page_action: Any) -> Any:
        await page_action(self.page)
        return Selector(content=b"<main><h1>Verify you are human</h1></main>", url="https://lens.google.com/sorry/")


@pytest.mark.asyncio
async def test_lens_upload_challenge_is_terminal(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import scrapling_worker.dom_ready

    monkeypatch.setattr(scrapling_worker.dom_ready, "DomReadySession", FakeStealthySession)
    image = tmp_path / "image-1"
    image.write_bytes(b"RIFF\x00\x00\x00\x00WEBPimage")
    adapter = ScraplingLensAdapter(_live_config())

    with pytest.raises(AdapterError) as raised:
        await adapter.search(StreamJob("job-1", "image-1", SearchOptions()), image)

    assert raised.value.code == "lens_challenge"
    assert raised.value.retryable is False
    upload = FakeStealthySession.instances[-1].page.lens_input.uploaded_file
    assert upload == {
        "name": "image-1.webp",
        "mimeType": "image/webp",
        "buffer": b"RIFF\x00\x00\x00\x00WEBPimage",
    }
    assert FakeStealthySession.instances[-1].kwargs["real_chrome"] is True
    await adapter.close()


@pytest.mark.asyncio
async def test_proxy_recovery_has_one_total_deadline_not_one_per_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    import scrapling_worker.dom_ready
    attempts = 0

    class SlowRecovery(FakeStealthySession):
        async def fetch(self, _url: str, *, page_action: Any) -> Any:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                await asyncio.sleep(0.8)
                raise AdapterError("lens_challenge", "verification", retryable=False)
            await asyncio.Event().wait()

    monkeypatch.setattr(scrapling_worker.dom_ready, "DomReadySession", SlowRecovery)
    adapter = ScraplingLensAdapter(WorkerConfig(
        mode="live", live_enabled=True, live_authorized=True, browser_timeout_ms=1000,
        proxy_url="http://user:pass@proxy.example.test:8080",
    ))
    image = tmp_path / "image-1"
    image.write_bytes(b"\x89PNG\r\n\x1a\npng")
    with pytest.raises(AdapterError) as raised:
        await asyncio.wait_for(adapter.search(StreamJob("job-1", "image-1", SearchOptions()), image), timeout=1.5)
    assert raised.value.code == "lens_loading"
    assert "total browser deadline" in str(raised.value)
    assert attempts == 2
    assert adapter._session is None


@pytest.mark.asyncio
async def test_deadline_during_proxy_disposal_keeps_one_owned_close_until_complete(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    import scrapling_worker.dom_ready
    closed = asyncio.Event()
    close_calls = 0

    class SlowDisposal(FakeStealthySession):
        async def fetch(self, _url: str, *, page_action: Any) -> Any:
            await asyncio.sleep(0.8)
            raise AdapterError("lens_challenge", "verification", retryable=False)

        async def __aexit__(self, *_args: Any) -> None:
            nonlocal close_calls
            close_calls += 1
            await asyncio.sleep(0.4)
            closed.set()

    monkeypatch.setattr(scrapling_worker.dom_ready, "DomReadySession", SlowDisposal)
    adapter = ScraplingLensAdapter(WorkerConfig(
        mode="live", live_enabled=True, live_authorized=True, browser_timeout_ms=1000,
        proxy_url="http://user:pass@proxy.example.test:8080",
    ))
    image = tmp_path / "image-1"
    image.write_bytes(b"\x89PNG\r\n\x1a\npng")
    with pytest.raises(AdapterError) as raised:
        await asyncio.wait_for(adapter.search(StreamJob("job-1", "image-1", SearchOptions()), image), timeout=2)
    assert raised.value.code == "lens_loading"
    assert closed.is_set()
    assert close_calls == 1
    assert adapter._session is None
    assert adapter._session_close is None


@pytest.mark.asyncio
async def test_hung_close_is_bounded_and_retains_ownership_until_disposal_finishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import scrapling_worker.adapters
    release = asyncio.Event()

    class HungSession(FakeStealthySession):
        async def __aexit__(self, *_args: Any) -> None:
            await release.wait()

    monkeypatch.setattr(scrapling_worker.adapters, "CLOSE_TIMEOUT_SECONDS", 0.05)
    adapter = ScraplingLensAdapter(_live_config())
    session = HungSession()
    adapter._session = session
    try:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(adapter.close(), timeout=0.2)
        assert adapter._session is session
        assert adapter._session_close is not None
    finally:
        release.set()
        await adapter.close()
    assert adapter._session is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("image_bytes", "filename", "mime_type"),
    [
        (b"\xff\xd8\xffjpeg", "image-1.jpg", "image/jpeg"),
        (b"\x89PNG\r\n\x1a\npng", "image-1.png", "image/png"),
        (b"RIFF\x00\x00\x00\x00WEBPwebp", "image-1.webp", "image/webp"),
    ],
)
async def test_extensionless_storage_images_upload_with_detected_browser_mime(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    image_bytes: bytes,
    filename: str,
    mime_type: str,
) -> None:
    import scrapling_worker.dom_ready

    monkeypatch.setattr(scrapling_worker.dom_ready, "DomReadySession", FakeStealthySession)
    image = tmp_path / "image-1"
    image.write_bytes(image_bytes)
    adapter = ScraplingLensAdapter(_live_config())

    with pytest.raises(AdapterError) as raised:
        await adapter.search(StreamJob("job-1", "image-1", SearchOptions()), image)

    assert raised.value.code == "lens_challenge"
    upload = FakeStealthySession.instances[-1].page.lens_input.uploaded_file
    assert upload is not None
    assert upload["name"] == filename
    assert upload["mimeType"] == mime_type
    assert upload["buffer"] == image_bytes
    await adapter.close()


@pytest.mark.asyncio
async def test_live_readiness_reports_unusable_chrome(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fail_smoke(*, timeout_ms: int) -> None:
        raise RuntimeError("missing browser")

    import scrapling_worker.browser_smoke

    monkeypatch.setattr(scrapling_worker.browser_smoke, "check_browser", fail_smoke)
    adapter = ScraplingLensAdapter(_live_config())

    with pytest.raises(AdapterError) as raised:
        await adapter.check_ready()

    assert raised.value.code == "browser_unavailable"
    assert raised.value.retryable is True


def test_proxy_normalization() -> None:
    from scrapling_worker.config import normalize_proxy_url

    # Colon-delimited with scheme and asn_701
    p1 = "socks5://portal.anyip.io:1080:test_user|type_mobile|country_us|asn_701:test_pass"
    assert normalize_proxy_url(p1) == "http://test_user|type_mobile|country_us:test_pass@portal.anyip.io:1080"

    # Colon-delimited without scheme
    p2 = "portal.anyip.io:1080:test_user|type_mobile|country_us:test_pass"
    assert normalize_proxy_url(p2) == "http://test_user|type_mobile|country_us:test_pass@portal.anyip.io:1080"

    # Standard URI with socks5 scheme
    p3 = "socks5://test_user|type_mobile|country_us|asn_701:test_pass@portal.anyip.io:1080"
    assert normalize_proxy_url(p3) == "http://test_user|type_mobile|country_us:test_pass@portal.anyip.io:1080"

    # Standard HTTP proxy
    p4 = "http://user:pass@127.0.0.1:8080"
    assert normalize_proxy_url(p4) == "http://user:pass@127.0.0.1:8080"

    # None and empty
    assert normalize_proxy_url(None) is None
    assert normalize_proxy_url("   ") is None


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [TimeoutError("navigation stalled"), RuntimeError("browser lost")])
async def test_navigation_failure_discards_session_without_hidden_retries(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, failure: Exception,
) -> None:
    import scrapling_worker.dom_ready
    sessions: list[Any] = []

    class BrokenSession(FakeStealthySession):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            self.closed = False
            sessions.append(self)

        async def fetch(self, _url: str, *, page_action: Any) -> Any:
            raise failure

        async def __aexit__(self, *_args: Any) -> None:
            self.closed = True

    monkeypatch.setattr(scrapling_worker.dom_ready, "DomReadySession", BrokenSession)
    image = tmp_path / "image-1"
    image.write_bytes(b"\x89PNG\r\n\x1a\npng")
    adapter = ScraplingLensAdapter(_live_config())
    for expected in [1, 2]:
        with pytest.raises(AdapterError):
            await adapter.search(StreamJob("job-1", "image-1", SearchOptions()), image)
        assert adapter._session is None
        assert len(sessions) == expected
        assert sessions[-1].closed


@pytest.mark.asyncio
async def test_adapter_passes_proxy_and_stealth_options_to_scrapling(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import scrapling_worker.dom_ready

    monkeypatch.setattr(scrapling_worker.dom_ready, "DomReadySession", FakeStealthySession)
    proxy = "http://user:pass@proxy.example.com:8080"
    cfg = WorkerConfig(
        mode="live",
        live_enabled=True,
        live_authorized=True,
        browser_timeout_ms=1000,
        proxy_url=proxy,
    )
    adapter = ScraplingLensAdapter(cfg)
    image = tmp_path / "image-1"
    image.write_bytes(b"\x89PNG\r\n\x1a\npng")

    with pytest.raises(AdapterError):
        await adapter.search(StreamJob("job-1", "image-1", SearchOptions()), image)

    kwargs = FakeStealthySession.instances[-1].kwargs
    assert kwargs.get("proxy") == proxy
    assert kwargs.get("google_search") is True
    assert kwargs.get("disable_resources") is False
    assert kwargs.get("block_webrtc") is True
    assert kwargs.get("real_chrome") is True
    await adapter.close()


def test_rotate_proxy_session() -> None:
    from scrapling_worker.adapters import rotate_proxy_session

    assert rotate_proxy_session(None) is None
    plain = "http://user:pass@127.0.0.1:8080"
    assert rotate_proxy_session(plain) == plain

    anyip_with_session = "http://user,session_orig123:pass@portal.anyip.io:1080"
    rotated1 = rotate_proxy_session(anyip_with_session)
    assert rotated1 is not None
    assert "session_orig123" not in rotated1
    assert "session_" in rotated1
    assert rotated1.endswith(":pass@portal.anyip.io:1080")

    anyip_without_session = "http://user:pass@portal.anyip.io:1080"
    rotated2 = rotate_proxy_session(anyip_without_session)
    assert rotated2 is not None
    assert "session_" in rotated2
    assert rotated2.endswith(":pass@portal.anyip.io:1080")


@pytest.mark.asyncio
async def test_challenge_flags_session_for_rotation_on_subsequent_request(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import scrapling_worker.dom_ready

    monkeypatch.setattr(scrapling_worker.dom_ready, "DomReadySession", FakeStealthySession)
    adapter = ScraplingLensAdapter(_live_config())
    image = tmp_path / "image-1"
    image.write_bytes(b"\x89PNG\r\n\x1a\npng")

    with pytest.raises(AdapterError):
        await adapter.search(StreamJob("job-1", "image-1", SearchOptions()), image)

    assert getattr(adapter, "_flagged_challenge", False) is True
    assert adapter._session is None
    session1 = FakeStealthySession.instances[-1]

    # Next call to _ensure_session rotates out the flagged session
    session2 = await adapter._ensure_session()
    assert session2 is not session1
    assert getattr(adapter, "_flagged_challenge", False) is False
    await adapter.close()


@pytest.mark.asyncio
async def test_proxy_challenge_can_recover_with_a_fresh_session_within_one_deadline(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import scrapling_worker.dom_ready

    attempts_made = 0

    class RetryFakeSession:
        def __init__(self, **kwargs: Any) -> None:
            nonlocal attempts_made
            attempts_made += 1
            self.kwargs = kwargs
            # Attempt 1 gets challenged, attempt 2 succeeds
            if attempts_made == 1:
                self.page = FakePage({"challenge": True, "empty": False, "results": False})
            else:
                self.page = FakePage({"challenge": False, "empty": False, "results": True})

        async def __aenter__(self) -> "RetryFakeSession":
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def fetch(self, _url: str, *, page_action: Any) -> Any:
            await page_action(self.page)
            return Selector(
                content=b'<main><a class="LBcIee" href="/goto?url=https://example.com/item">Item</a></main>',
                url="https://google.com/search?udm=26",
            )

    monkeypatch.setattr(scrapling_worker.dom_ready, "DomReadySession", RetryFakeSession)
    config = WorkerConfig(
        mode="live",
        live_enabled=True,
        live_authorized=True,
        browser_timeout_ms=1000,
        proxy_url="http://test_user:test_pass@portal.anyip.io:1080",
    )
    adapter = ScraplingLensAdapter(config)
    image = tmp_path / "image-1"
    image.write_bytes(b"\x89PNG\r\n\x1a\npng")

    snapshot = await adapter.search(StreamJob("job-1", "image-1", SearchOptions()), image)
    assert attempts_made == 2
    assert len(snapshot.links) == 1
    assert snapshot.links[0].href == "https://google.com/goto?url=https://example.com/item"
    await adapter.close()
