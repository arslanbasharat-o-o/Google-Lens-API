from datetime import datetime, timezone
from pathlib import Path

import pytest
from scrapling.parser import Selector

from scrapling_worker.adapters import FixturePageAdapter, FakePage, _visible_file_input
from scrapling_worker.contract import SearchOptions, StreamJob
from scrapling_worker.parser import LensParseError, classify_snapshot, result_from_snapshot, snapshot_from_page


FIXTURES = Path("scrapling_worker/fixtures")


def _job(search_type: str = "all") -> StreamJob:
    return StreamJob("job-1", "image-1", SearchOptions(type=search_type))


def test_scrapling_selector_parser_normalizes_match_fields() -> None:
    page = Selector(content=(FIXTURES / "success.html").read_bytes(), url="fixture://success")
    snapshot = snapshot_from_page(page)
    result = result_from_snapshot(
        _job(),
        snapshot,
        started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        processed_at=datetime(2026, 1, 1, 0, 0, 1, tzinfo=timezone.utc),
        source="mock",
    )

    match = result["visual_matches"][0]
    assert match["title"] == "Blue chair product listing"
    assert match["source"] == "example.com"
    assert match["thumbnail"] == "https://cdn.example.com/thumb.jpg"
    assert match["image"] == "https://cdn.example.com/blue-chair.jpg"
    assert match["price"] == "$29.99"
    assert match["extracted_price"] == 29.99
    assert result["related_content"][0]["query"] == "blue chair"


@pytest.mark.parametrize(
    ("fixture", "failure"),
    [("challenge", "challenge"), ("empty", "empty"), ("loading", "loading")],
)
def test_parser_preserves_observable_terminal_state(fixture: str, failure: str) -> None:
    page = Selector(content=(FIXTURES / f"{fixture}.html").read_bytes(), url=f"fixture://{fixture}")
    snapshot = snapshot_from_page(page)

    assert classify_snapshot(snapshot) == failure
    with pytest.raises(LensParseError) as raised:
        result_from_snapshot(
            _job(),
            snapshot,
            started_at=datetime.now(timezone.utc),
            processed_at=datetime.now(timezone.utc),
            source="mock",
        )
    assert raised.value.code == f"lens_{failure}"
    assert raised.value.retryable is (failure == "loading")


def test_exact_match_option_hides_visual_matches() -> None:
    page = Selector(content=(FIXTURES / "success.html").read_bytes(), url="fixture://success")
    result = result_from_snapshot(
        _job("exact_matches"),
        snapshot_from_page(page),
        started_at=datetime.now(timezone.utc),
        processed_at=datetime.now(timezone.utc),
        source="mock",
    )

    assert result["visual_matches"] == []


@pytest.mark.asyncio
async def test_fake_page_models_visible_file_input_without_browser(tmp_path: Path) -> None:
    page = FakePage()
    file_input = await _visible_file_input(page)

    assert file_input is not None
    await file_input.set_input_files(str(tmp_path / "image.png"))
    assert page.file_input.uploaded_path == str(tmp_path / "image.png")


@pytest.mark.asyncio
async def test_fixture_adapter_does_not_need_browser(tmp_path: Path) -> None:
    image = tmp_path / "image-1"
    image.write_bytes(b"fixture image bytes")
    adapter = FixturePageAdapter(FIXTURES)

    snapshot = await adapter.search(_job(), image)

    assert snapshot.links[0].href == "https://example.com/products/blue-chair"
    await adapter.close()
