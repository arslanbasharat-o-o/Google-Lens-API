"""Redis Streams v1 wire contract and key helpers.

The producer writes one Redis Streams entry with the fields described in
``docs/scrapling-worker.md``. Values are strings; JSON fields are UTF-8 JSON.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping

STREAM_NAME = "lens:jobs:v1"
CONSUMER_GROUP = "scrapling-workers"
RESULT_PREFIX = "lens:result:v1:"
CANCEL_PREFIX = "lens:cancel:v1:"
WORKER_HEARTBEAT_KEY = "lens:worker:heartbeat:v1"


class ContractError(ValueError):
    """A malformed stream entry that cannot be processed safely."""


def _text(value: object | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _optional_text(fields: Mapping[object, object], name: str) -> str | None:
    for key, value in fields.items():
        if _text(key) == name:
            text = _text(value)
            return text.strip() if text and text.strip() else None
    return None


def _required_text(fields: Mapping[object, object], name: str) -> str:
    value = _optional_text(fields, name)
    if not value:
        raise ContractError(f"missing required stream field: {name}")
    return value


def _json_object(raw: str, field_name: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ContractError(f"invalid JSON stream field: {field_name}") from exc
    if not isinstance(value, dict):
        raise ContractError(f"JSON stream field must be an object: {field_name}")
    return value


@dataclass(frozen=True, slots=True)
class SearchOptions:
    engine: str = "google_lens"
    type: str = "all"
    q: str | None = None
    hl: str | None = None
    country: str | None = None
    safe: str | None = None
    auto_crop: bool | None = None
    no_cache: bool | None = None
    async_request: bool | None = None

    @classmethod
    def from_fields(cls, fields: Mapping[object, object]) -> "SearchOptions":
        options_json = _optional_text(fields, "options_json")
        raw: dict[str, Any] = _json_object(options_json, "options_json") if options_json else {}

        def value(name: str, *aliases: str) -> Any:
            if name in raw:
                return raw[name]
            for alias in aliases:
                if alias in raw:
                    return raw[alias]
            return _optional_text(fields, name)

        def optional_bool(name: str, *aliases: str) -> bool | None:
            candidate = value(name, *aliases)
            if candidate is None or candidate == "":
                return None
            if isinstance(candidate, bool):
                return candidate
            if isinstance(candidate, str) and candidate.strip().lower() in {"1", "true", "yes", "on"}:
                return True
            if isinstance(candidate, str) and candidate.strip().lower() in {"0", "false", "no", "off"}:
                return False
            raise ContractError(f"invalid boolean search option: {name}")

        engine = str(value("engine") or "google_lens")
        search_type = str(value("type") or "all")
        if engine != "google_lens":
            raise ContractError(f"unsupported engine: {engine}")
        if search_type not in {"all", "visual_matches", "exact_matches"}:
            raise ContractError(f"unsupported search type: {search_type}")

        return cls(
            engine=engine,
            type=search_type,
            q=_clean_optional(value("q")),
            hl=_clean_optional(value("hl")),
            country=_clean_optional(value("country")),
            safe=_clean_optional(value("safe")),
            auto_crop=optional_bool("auto_crop", "autoCrop"),
            no_cache=optional_bool("no_cache", "noCache"),
            async_request=optional_bool("async_request", "async"),
        )

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"engine": self.engine, "type": self.type}
        for name, value in (
            ("q", self.q),
            ("hl", self.hl),
            ("country", self.country),
            ("safe", self.safe),
            ("autoCrop", self.auto_crop),
            ("noCache", self.no_cache),
            ("async", self.async_request),
        ):
            if value is not None:
                result[name] = value
        return result


@dataclass(frozen=True, slots=True)
class StreamJob:
    job_id: str
    image_id: str
    options: SearchOptions
    dispatch_id: str = ""
    attempt: int = 1
    created_at: str | None = None
    fixture: str | None = None

    @classmethod
    def from_fields(cls, fields: Mapping[object, object]) -> "StreamJob":
        return cls(
            job_id=_required_text(fields, "job_id"),
            dispatch_id=_required_text(fields, "dispatch_id"),
            attempt=_positive_int(fields, "attempt"),
            image_id=_required_text(fields, "image_id"),
            options=SearchOptions.from_fields(fields),
            created_at=_optional_text(fields, "created_at"),
            fixture=_optional_text(fields, "fixture"),
        )


def result_key(job_id: str, attempt: int = 1) -> str:
    return f"{RESULT_PREFIX}{job_id}:{attempt}"


def cancellation_key(job_id: str) -> str:
    return f"{CANCEL_PREFIX}{job_id}"


def _clean_optional(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _positive_int(fields: Mapping[object, object], name: str) -> int:
    raw = _required_text(fields, name)
    try:
        value = int(raw)
    except ValueError as exc:
        raise ContractError(f"invalid integer stream field: {name}") from exc
    if value < 1:
        raise ContractError(f"stream field must be positive: {name}")
    return value
