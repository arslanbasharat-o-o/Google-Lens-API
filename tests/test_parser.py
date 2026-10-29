from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest
from scrapling.parser import Selector

from scrapling_worker.adapters import FixturePageAdapter
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


def test_parser_extracts_only_text_adjacent_to_an_explicit_ai_overview_heading() -> None:
    page = Selector(content=(FIXTURES / "success-ai-overview.html").read_bytes(), url="https://lens.google.com/search")
    snapshot = snapshot_from_page(page)
    result = result_from_snapshot(
        _job(),
        snapshot,
        started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        processed_at=datetime(2026, 1, 1, 0, 0, 1, tzinfo=timezone.utc),
        source="mock",
    )

    assert snapshot.aiOverview == (
        "The image shows a replacement display assembly, such as an iPhone 11 panel or a similar compatible model."
    )
    assert result["ai_overview"] == snapshot.aiOverview
    assert "Parts shop" not in result["ai_overview"]
    assert "iPhone 11 Pro display assembly" not in result["ai_overview"]
    assert snapshot.aiMode is not None
    assert snapshot.aiMode["text"] == snapshot.aiOverview
    assert snapshot.aiMode["sources"] == [{"title": "Source", "link": "https://example.com/source"}]
    assert result["ai_mode"] == snapshot.aiMode


def test_parser_extracts_ai_mode_heading_with_bullet_points() -> None:
    html = b"""
    <main>
      <section class="overview">
        <div role="heading">AI Mode</div>
        <div>
          <p>Display dimensions:</p>
          <ul>
            <li>Length: 147.5 mm</li>
            <li>Width: 71.5 mm</li>
          </ul>
          <a href="https://example.com/specs">Specs Source</a>
        </div>
      </section>
      <section data-lens-section="visual-matches">
        <a class="LBcIee" href="https://www.google.com/goto?url=opaque"><span>Parts shop</span><span>iPhone 14 Pro display</span></a>
      </section>
    </main>
    """
    page = Selector(content=html, url="https://lens.google.com/search")
    snapshot = snapshot_from_page(page)
    result = result_from_snapshot(
        _job(),
        snapshot,
        started_at=datetime.now(timezone.utc),
        processed_at=datetime.now(timezone.utc),
        source="mock",
    )

    assert "147.5 mm" in snapshot.aiOverview
    assert "71.5 mm" in snapshot.aiOverview
    assert snapshot.aiMode["sources"] == [{"title": "Specs Source", "link": "https://example.com/specs"}]
    assert result["ai_mode"] == snapshot.aiMode


def test_parser_omits_ai_overview_when_no_explicit_heading_exists() -> None:
    page = Selector(content=(FIXTURES / "success.html").read_bytes(), url="fixture://success")

    snapshot = snapshot_from_page(page)
    result = result_from_snapshot(
        _job(),
        snapshot,
        started_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        processed_at=datetime(2026, 1, 1, 0, 0, 1, tzinfo=timezone.utc),
        source="mock",
    )

    assert snapshot.aiOverview is None
    assert "ai_overview" not in result


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


def test_google_sorry_url_is_a_terminal_challenge_even_without_english_text() -> None:
    page = Selector(content=(FIXTURES / "success.html").read_bytes(), url="fixture://success")
    snapshot = replace(
        snapshot_from_page(page),
        url="https://www.google.com/sorry/index?continue=search",
        bodyText="Verification required",
    )

    assert classify_snapshot(snapshot) == "challenge"
    with pytest.raises(LensParseError) as raised:
        result_from_snapshot(
            _job(),
            snapshot,
            started_at=datetime.now(timezone.utc),
            processed_at=datetime.now(timezone.utc),
            source="scrapling",
        )
    assert raised.value.code == "lens_challenge"
    assert raised.value.retryable is False


def test_current_google_lens_card_keeps_goto_link_and_seller() -> None:
    page = Selector(
        content=b'<main><a class="LBcIee" href="/goto?url=opaque"><span>Parts shop</span><span>iPhone 15 Pro display</span></a></main>',
        url="https://www.google.com/search?udm=26",
    )
    snapshot = snapshot_from_page(page)

    assert len(snapshot.links) == 1
    assert snapshot.links[0].href == "https://www.google.com/goto?url=opaque"
    assert snapshot.links[0].source == "Parts shop"
    assert "iPhone 15 Pro display" in snapshot.links[0].text


def test_google_lens_goto_link_does_not_require_volatile_card_class() -> None:
    page = Selector(
        content=b'<main><a href="/goto?url=opaque"><span>Parts shop</span><span>iPhone 15 Pro display</span></a></main>',
        url="https://www.google.com/search?udm=26",
    )

    snapshot = snapshot_from_page(page)

    assert len(snapshot.links) == 1
    assert snapshot.links[0].href == "https://www.google.com/goto?url=opaque"


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


def test_contract_options_handles_prompt() -> None:
    options = SearchOptions.from_fields({"prompt": "measure screen width"})
    assert options.q == "measure screen width"
    assert options.prompt == "measure screen width"


def test_parse_ai_overview_and_mode_from_aimfl_containers() -> None:
    html = """
    <html>
      <body>
        <div class="mZJni Dn7Fzd">
          <div class="n6owBd awi2gc">
            <span data-subtree="aimfl,mfl">The selected item is an iPhone 14 Plus screen assembly with 6708VR stamping.</span>
            <a href="/goto?url=https%3A%2F%2Fexample.com%2Fpart">Supplier Info</a>
          </div>
        </div>
      </body>
    </html>
    """
    page = Selector(content=html.encode("utf-8"), url="https://www.google.com/search")
    snapshot = snapshot_from_page(page)

    assert snapshot.aiOverview is not None
    assert "iPhone 14 Plus" in snapshot.aiOverview
    assert snapshot.aiMode is not None
    assert "iPhone 14 Plus" in snapshot.aiMode["text"]
    assert len(snapshot.aiMode["sources"]) == 1
    assert snapshot.aiMode["sources"][0]["title"] == "Supplier Info"


@pytest.mark.asyncio
async def test_fixture_adapter_does_not_need_browser(tmp_path: Path) -> None:
    image = tmp_path / "image-1"
    image.write_bytes(b"fixture image bytes")
    adapter = FixturePageAdapter(FIXTURES)

    snapshot = await adapter.search(_job(), image)

    assert snapshot.links[0].href == "https://example.com/products/blue-chair"
    await adapter.close()
