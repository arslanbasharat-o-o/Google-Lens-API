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

    async def set_input_files(self, file_payload: dict[str, Any]) -> None:
        self.uploaded_file = file_payload


class FakeElement:
    async def count(self) -> int:
        return 0

    async def click(self, **kwargs: Any) -> None:
        return None


class FakePage:
    def __init__(self, state: dict[str, bool]) -> None:
        self.state = state
        self.lens_input = FakeLensInput()

    def locator(self, selector: str) -> Any:
        if selector == '[aria-label="Search by image"]':
            return FakeElement()
        assert selector == 'input[type="file"][name="encoded_image"]'
        return self.lens_input

    async def evaluate(self, _script: str) -> dict[str, bool]:
        return self.state


class FakeStealthySession:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
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
    import scrapling.fetchers

    monkeypatch.setattr(scrapling.fetchers, "AsyncStealthySession", FakeStealthySession)
    image = tmp_path / "image-1"
    image.write_bytes(b"RIFF\x00\x00\x00\x00WEBPimage")
    adapter = ScraplingLensAdapter(_live_config())

    with pytest.raises(AdapterError) as raised:
        await adapter.search(StreamJob("job-1", "image-1", SearchOptions()), image)

    assert raised.value.code == "lens_challenge"
    assert raised.value.retryable is False
    upload = adapter._session.page.lens_input.uploaded_file
    assert upload == {
        "name": "image-1.webp",
        "mimeType": "image/webp",
        "buffer": b"RIFF\x00\x00\x00\x00WEBPimage",
    }
    assert adapter._session.kwargs["real_chrome"] is True
    await adapter.close()


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
    import scrapling.fetchers

    monkeypatch.setattr(scrapling.fetchers, "AsyncStealthySession", FakeStealthySession)
    image = tmp_path / "image-1"
    image.write_bytes(image_bytes)
    adapter = ScraplingLensAdapter(_live_config())

    with pytest.raises(AdapterError) as raised:
        await adapter.search(StreamJob("job-1", "image-1", SearchOptions()), image)

    assert raised.value.code == "lens_challenge"
    upload = adapter._session.page.lens_input.uploaded_file
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
async def test_adapter_passes_proxy_and_stealth_options_to_scrapling(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import scrapling.fetchers

    monkeypatch.setattr(scrapling.fetchers, "AsyncStealthySession", FakeStealthySession)
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

    kwargs = adapter._session.kwargs
    assert kwargs.get("proxy") == proxy
    assert kwargs.get("google_search") is True
    assert kwargs.get("disable_resources") is True
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
    import scrapling.fetchers

    monkeypatch.setattr(scrapling.fetchers, "AsyncStealthySession", FakeStealthySession)
    adapter = ScraplingLensAdapter(_live_config())
    image = tmp_path / "image-1"
    image.write_bytes(b"\x89PNG\r\n\x1a\npng")

    with pytest.raises(AdapterError):
        await adapter.search(StreamJob("job-1", "image-1", SearchOptions()), image)

    assert getattr(adapter, "_flagged_challenge", False) is True
    session1 = adapter._session

    # Next call to _ensure_session rotates out the flagged session
    session2 = await adapter._ensure_session()
    assert session2 is not session1
    assert getattr(adapter, "_flagged_challenge", False) is False
    await adapter.close()



