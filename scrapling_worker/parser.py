"""Scrapling selector parser and TypeScript-compatible normalized output."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol
from urllib.parse import urljoin, urlparse

from .contract import SearchOptions, StreamJob


class PageLike(Protocol):
    url: str

    def css(self, selector: str) -> Any: ...

    def get_all_text(
        self,
        separator: str = "\n",
        strip: bool = False,
        ignore_tags: tuple[Any, ...] = ("script", "style"),
        valid_values: bool = True,
    ) -> Any: ...


class LensParseError(ValueError):
    """A visible Lens state or parser failure with the TypeScript error code."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class LensLink:
    href: str
    text: str
    source: str | None = None
    sourceIcon: str | None = None
    thumbnail: str | None = None
    image: str | None = None
    imageWidth: int | None = None
    imageHeight: int | None = None
    price: str | None = None
    extractedPrice: float | None = None
    currency: str | None = None
    rating: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {key: value for key, value in asdict(self).items() if value is not None}


@dataclass(frozen=True, slots=True)
class RelatedContent:
    query: str
    href: str | None = None
    thumbnail: str | None = None

    def to_dict(self) -> dict[str, str]:
        return {key: value for key, value in asdict(self).items() if value is not None}


@dataclass(frozen=True, slots=True)
class LensPageSnapshot:
    url: str
    title: str
    bodyText: str
    links: list[LensLink] = field(default_factory=list)
    exactMatches: list[LensLink] = field(default_factory=list)
    relatedContent: list[RelatedContent] = field(default_factory=list)
    loading: bool = False
    observedAt: str = ""
    timings: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "title": self.title,
            "bodyText": self.bodyText,
            "links": [item.to_dict() for item in self.links],
            "exactMatches": [item.to_dict() for item in self.exactMatches],
            "relatedContent": [item.to_dict() for item in self.relatedContent],
            "loading": self.loading,
            "observedAt": self.observedAt,
            "timings": dict(self.timings),
        }


CHALLENGE_PATTERN = re.compile(
    r"captcha|recaptcha|verify you are human|unusual traffic|not a robot|robot check|automated queries",
    re.IGNORECASE,
)
EMPTY_PATTERN = re.compile(
    r"no (?:visual )?matches|no results found|couldn['’]t find|try another image|nothing found",
    re.IGNORECASE,
)
LOADING_PATTERN = re.compile(r"loading|searching|processing|analy[sz]ing|please wait", re.IGNORECASE)

RESULT_SELECTOR = (
    '[data-lens-result], [data-visual-match], [data-result-card], '
    '[data-lens-section="visual-matches"] a[href], main a.LBcIee[href], [role="main"] a.LBcIee[href], '
    'main a[href^="/goto?url="], [role="main"] a[href^="/goto?url="]'
)
EXACT_SELECTOR = '[data-exact-match], [data-lens-section="exact-matches"] a[href]'
FALLBACK_SELECTOR = 'main a[href], [role="main"] a[href], [data-content-feature="1"] a[href]'


def snapshot_from_page(page: PageLike, *, timings: dict[str, int] | None = None) -> LensPageSnapshot:
    """Build a stable snapshot using Scrapling's selector API only."""

    body_text = _clean_text(page.get_all_text(separator=" ", strip=True))
    visual_nodes = list(page.css(RESULT_SELECTOR)) or list(page.css(FALLBACK_SELECTOR))
    exact_nodes = list(page.css(EXACT_SELECTOR))
    links = _parse_links(visual_nodes, page.url)
    exact_matches = _parse_links(exact_nodes, page.url)
    related_content = _parse_related(page, page.url)
    loading = bool(page.css('[aria-busy="true"], [role="progressbar"], [data-loading="true"]'))
    loading = loading or bool(page.css('[data-lens-loading-timeout="true"]'))
    return LensPageSnapshot(
        url=str(page.url),
        title=_first_text(page, "title::text") or _first_text(page, "h1::text") or "",
        bodyText=body_text,
        links=links,
        exactMatches=exact_matches,
        relatedContent=related_content,
        loading=loading,
        observedAt=_now_iso(),
        timings=timings or {},
    )


def classify_snapshot(snapshot: LensPageSnapshot) -> str | None:
    if urlparse(snapshot.url).path.startswith("/sorry/") or CHALLENGE_PATTERN.search(snapshot.bodyText):
        return "challenge"
    if (snapshot.loading and not snapshot.links and not snapshot.exactMatches) or (
        not snapshot.links and not snapshot.exactMatches and LOADING_PATTERN.search(snapshot.bodyText)
    ):
        return "loading"
    if EMPTY_PATTERN.search(snapshot.bodyText):
        return "empty"
    if not snapshot.links and not snapshot.exactMatches:
        return "parser"
    return None


def result_from_snapshot(
    job: StreamJob,
    snapshot: LensPageSnapshot,
    *,
    started_at: datetime,
    processed_at: datetime,
    source: str,
    cached: bool = False,
) -> dict[str, Any]:
    failure = classify_snapshot(snapshot)
    if failure:
        retryable = failure == "loading"
        message = {
            "challenge": "The Lens page requested human verification; automation stopped.",
            "loading": "The Lens page did not leave its loading state before the timeout.",
            "empty": "Lens returned no visual matches for the uploaded image.",
            "parser": "Lens returned a page without parseable result links.",
        }[failure]
        raise LensParseError(f"lens_{failure}", message, retryable=retryable)

    links = [_normalize_link(item, index + 1) for index, item in enumerate(snapshot.links)]
    exact_matches = [_normalize_link(item, index + 1) for index, item in enumerate(snapshot.exactMatches)]
    links = [item for item in links if item is not None]
    exact_matches = [item for item in exact_matches if item is not None]
    if not links and not exact_matches:
        raise LensParseError("lens_parser", "No valid visual match links could be normalized.")

    related = [
        {
            "query": item.query.strip(),
            **({"link": item.href} if item.href else {}),
            **({"thumbnail": item.thumbnail} if item.thumbnail else {}),
        }
        for item in snapshot.relatedContent
        if item.query.strip()
    ]
    result: dict[str, Any] = {
        "search_metadata": {
            "id": job.job_id,
            "status": "Success",
            "json_endpoint": f"/v1/jobs/{job.job_id}",
            "created_at": started_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "processed_at": processed_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "total_time_taken": max(0.0, (processed_at - started_at).total_seconds()),
            "cached": cached,
            "source": source,
        },
        "search_parameters": job.options.to_dict(),
        "visual_matches": [] if job.options.type == "exact_matches" else links,
    }
    if exact_matches:
        result["exact_matches"] = exact_matches
    if related:
        result["related_content"] = related
    return result


def _normalize_link(item: LensLink, position: int) -> dict[str, Any] | None:
    """Map the camel-case snapshot fields to the TypeScript response fields."""

    href = _absolute_http_url(item.href, item.href)
    title = _clean_optional(item.text)
    if not href or not title:
        return None
    normalized: dict[str, Any] = {
        "position": position,
        "title": title,
        "link": href,
        "source": _clean_optional(item.source) or _host(href),
    }
    for source_name, output_name in (
        ("sourceIcon", "source_icon"),
        ("thumbnail", "thumbnail"),
        ("image", "image"),
        ("imageWidth", "image_width"),
        ("imageHeight", "image_height"),
        ("price", "price"),
        ("extractedPrice", "extracted_price"),
        ("currency", "currency"),
        ("rating", "rating"),
    ):
        value = getattr(item, source_name)
        if source_name in {"sourceIcon", "thumbnail", "image"} and isinstance(value, str):
            value = _absolute_http_url(value, href)
        if value is not None and value != "":
            normalized[output_name] = value
    return normalized


def _parse_links(nodes: list[Any], base_url: str) -> list[LensLink]:
    result: list[LensLink] = []
    seen: set[str] = set()
    for node in nodes:
        anchor = node if getattr(node, "tag", "") == "a" else _first_selector(node, "a[href]")
        if anchor is None:
            continue
        href = _absolute_http_url(str(anchor.attrib.get("href", "")), base_url)
        text = _clean_text(_element_text(anchor))
        if not href or not text or href in seen or _is_google_navigation(href):
            continue
        source_name: str | None = None
        if urlparse(href).path == "/goto" and _host(href).removeprefix("www.") == "google.com":
            lines = [_clean_text(line) for line in str(anchor.get_all_text(separator="\n", strip=True)).splitlines()]
            lines = [line for line in lines if line]
            if len(lines) > 1 and len(lines[0]) <= 80:
                source_name, text = lines[0], " ".join(lines[1:])
        seen.add(href)
        card = _result_card(anchor)
        price_text = _first_text(card, '[data-price]::text, [itemprop="price"]::text')
        if not price_text:
            price_text = _first_attribute(card, '[data-price], [itemprop="price"]', "content")
        extracted_price = _number(price_text)
        result.append(
            LensLink(
                href=href,
                text=text,
                source=_clean_optional(str(card.attrib.get("data-source", ""))) or source_name or _host(href),
                sourceIcon=_absolute_optional(_first_attribute(card, "[data-source-icon]", "src"), base_url),
                thumbnail=_absolute_optional(
                    _first_attribute(card, "img", "data-src") or _first_attribute(card, "img", "src"), base_url
                ),
                image=_absolute_optional(
                    _first_attribute(card, "[data-result-image]", "src")
                    or _first_attribute(card, "[data-result-image]", "data-result-image"),
                    base_url,
                ),
                imageWidth=_integer(
                    _first_attribute(card, "[data-result-image], img", "data-width")
                    or _first_attribute(card, "[data-result-image], img", "width")
                ),
                imageHeight=_integer(
                    _first_attribute(card, "[data-result-image], img", "data-height")
                    or _first_attribute(card, "[data-result-image], img", "height")
                ),
                price=_clean_optional(price_text),
                extractedPrice=extracted_price,
                currency=_currency(price_text),
                rating=_number(_first_text(card, '[data-rating]::text, [aria-label*="rating" i]::text')),
            )
        )
    return result


def _parse_related(page: PageLike, base_url: str) -> list[RelatedContent]:
    result: list[RelatedContent] = []
    for anchor in page.css('[data-related-content] a[href], [data-lens-section="related-content"] a[href]'):
        query = _clean_text(_element_text(anchor))
        href = _absolute_http_url(str(anchor.attrib.get("href", "")), base_url)
        thumbnail = _absolute_optional(
            _first_attribute(anchor, "img", "data-src") or _first_attribute(anchor, "img", "src"), base_url
        )
        if query:
            result.append(RelatedContent(query=query, href=href, thumbnail=thumbnail))
    return result


def _result_card(anchor: Any) -> Any:
    candidate = anchor.find_ancestor(
        lambda element: bool(
            element.attrib.get("data-lens-result")
            or element.attrib.get("data-visual-match")
            or element.attrib.get("data-result-card")
            or element.tag in {"article", "li"}
        )
    )
    return candidate or anchor


def _first_selector(element: Any, selector: str) -> Any | None:
    values = element.css(selector)
    return values[0] if values else None


def _first_text(element: Any, selector: str) -> str | None:
    values = element.css(selector)
    if not values:
        return None
    value = values[0]
    return _clean_text(str(value.get() if getattr(value, "tag", "") == "#text" else _element_text(value))) or None


def _first_attribute(element: Any, selector: str, attribute: str) -> str | None:
    value = _first_selector(element, selector)
    if value is None:
        return None
    raw = value.attrib.get(attribute)
    return _clean_optional(str(raw)) if raw is not None else None


def _element_text(element: Any) -> str:
    try:
        return str(element.get_all_text(separator=" ", strip=True))
    except AttributeError:
        return str(getattr(element, "text", ""))


def _clean_text(value: str) -> str:
    return " ".join(value.split())


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    value = _clean_text(value)
    return value or None


def _absolute_http_url(value: str, base_url: str) -> str | None:
    if not value:
        return None
    absolute = urljoin(base_url, value)
    parsed = urlparse(absolute)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return absolute


def _absolute_optional(value: str | None, base_url: str) -> str | None:
    return _absolute_http_url(value or "", base_url)


def _host(url: str) -> str:
    return urlparse(url).hostname or "unknown"


def _is_google_navigation(url: str) -> bool:
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower().removeprefix("www.")
    # Current Lens cards use Google's /goto endpoint as their result link.
    # Keep those redirect links while excluding search/navigation controls.
    if hostname == "google.com" and parsed.path == "/goto":
        return False
    return hostname == "google.com" or hostname.endswith(".google.com") or hostname.endswith(".googleusercontent.com")


def _number(value: str | None) -> float | None:
    if not value:
        return None
    match = re.search(r"\d+(?:[.,]\d+)?", value.replace(",", ""))
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _integer(value: str | None) -> int | None:
    number = _number(value)
    return int(number) if number is not None else None


def _currency(value: str | None) -> str | None:
    if not value:
        return None
    match = re.search(r"[$€£]|\b(?:USD|EUR|GBP|PKR)\b", value, re.IGNORECASE)
    return match.group(0).upper() if match else None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
