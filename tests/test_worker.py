import json
from pathlib import Path
from typing import Any, Mapping

import pytest

from scrapling_worker.adapters import AdapterError
from scrapling_worker.config import WorkerConfig
from scrapling_worker.contract import result_key
from scrapling_worker.parser import LensPageSnapshot
from scrapling_worker.worker import StreamsWorker


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.attempts: dict[str, int] = {}
        self.acks: list[str] = []
        self.events: list[str] = []
        self.pending: list[tuple[str, Mapping[object, object]]] = []

    async def xgroup_create(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def xreadgroup(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []

    async def xautoclaim(self, *args: Any, **kwargs: Any) -> list[Any]:
        entries = self.pending
        self.pending = []
        return ["0-0", entries, []]

    async def xack(self, name: str, group: str, entry_id: str) -> int:
        self.events.append("ack")
        self.acks.append(entry_id)
        return 1

    async def get(self, name: str) -> str | None:
        return self.values.get(name)

    async def setex(self, name: str, time: int, value: str) -> bool:
        self.events.append("setex")
        self.values[name] = value
        return True

    async def incr(self, name: str) -> int:
        self.attempts[name] = self.attempts.get(name, 0) + 1
        return self.attempts[name]

    async def expire(self, name: str, time: int) -> bool:
        return True


class FakeAdapter:
    def __init__(self, snapshot: LensPageSnapshot | None = None, error: Exception | None = None) -> None:
        self.snapshot = snapshot or LensPageSnapshot(
            url="fixture://success",
            title="Fixture Lens results",
            bodyText="Visual matches",
            links=[],
            exactMatches=[],
            relatedContent=[],
            loading=False,
        )
        self.error = error
        self.calls = 0

    async def search(self, job: Any, image_path: Path) -> LensPageSnapshot:
        self.calls += 1
        if self.error:
            raise self.error
        return self.snapshot

    async def close(self) -> None:
        return None


class ResultAdapter(FakeAdapter):
    def __init__(self) -> None:
        super().__init__(
            LensPageSnapshot(
                url="fixture://success",
                title="Result",
                bodyText="Visual matches",
                links=[],
                exactMatches=[],
                relatedContent=[],
                loading=False,
            )
        )
        # Keep the worker test focused on Redis ordering; the parser has its
        # own fixture coverage and this snapshot is replaced below.


def fields(**overrides: str) -> dict[str, str]:
    result = {
        "job_id": "job-1",
        "dispatch_id": "job-1:1",
        "attempt": "1",
        "image_id": "image-1",
        "engine": "google_lens",
        "type": "all",
    }
    result.update(overrides)
    return result


def config(tmp_path: Path) -> WorkerConfig:
    image_dir = tmp_path / "images"
    image_dir.mkdir()
    (image_dir / "image-1").write_bytes(b"image")
    return WorkerConfig(image_storage_dir=image_dir, mode="fixture", result_ttl_seconds=60, max_attempts=2)


def success_snapshot() -> LensPageSnapshot:
    from scrapling.parser import Selector
    from scrapling_worker.parser import snapshot_from_page

    return snapshot_from_page(
        Selector(
            content=b'<main><a href="https://example.test/item">Example item</a></main>',
            url="fixture://success",
        )
    )


@pytest.mark.asyncio
async def test_result_is_set_before_ack(tmp_path: Path) -> None:
    redis = FakeRedis()
    adapter = FakeAdapter(snapshot=success_snapshot())
    worker = StreamsWorker(redis, config(tmp_path), adapter)

    assert await worker.process_entry("1-0", fields()) is True

    assert redis.events[-2:] == ["setex", "ack"]
    payload = json.loads(redis.values[result_key("job-1")])
    assert payload["status"] == "succeeded"
    assert payload["result"]["visual_matches"][0]["link"] == "https://example.test/item"
    assert redis.acks == ["1-0"]


@pytest.mark.asyncio
async def test_existing_result_is_idempotent_and_skips_adapter(tmp_path: Path) -> None:
    redis = FakeRedis()
    redis.values[result_key("job-1")] = '{"status":"succeeded"}'
    adapter = FakeAdapter(snapshot=success_snapshot())
    worker = StreamsWorker(redis, config(tmp_path), adapter)

    assert await worker.process_entry("1-0", fields()) is True

    assert adapter.calls == 0
    assert redis.acks == ["1-0"]


@pytest.mark.asyncio
async def test_cancellation_is_terminal_and_acknowledged(tmp_path: Path) -> None:
    redis = FakeRedis()
    redis.values["lens:cancel:v1:job-1"] = "1"
    adapter = FakeAdapter(snapshot=success_snapshot())
    worker = StreamsWorker(redis, config(tmp_path), adapter)

    assert await worker.process_entry("1-0", fields()) is True

    payload = json.loads(redis.values[result_key("job-1")])
    assert payload["status"] == "cancelled"
    assert adapter.calls == 0
    assert redis.acks == ["1-0"]


@pytest.mark.asyncio
async def test_retryable_failure_is_owned_by_dispatch_and_api_retries_with_next_attempt(tmp_path: Path) -> None:
    redis = FakeRedis()
    adapter = FakeAdapter(snapshot=success_snapshot(), error=AdapterError("lens_browser", "browser failed", retryable=True))
    worker = StreamsWorker(redis, config(tmp_path), adapter)

    assert await worker.process_entry("1-0", fields()) is True

    payload = json.loads(redis.values[result_key("job-1")])
    assert payload["status"] == "failed"
    assert payload["dispatch_id"] == "job-1:1"
    assert payload["error"]["retryable"] is True
    assert payload["error"]["dead_letter"] is False
    assert redis.acks == ["1-0"]

    adapter.error = None
    assert await worker.process_entry("2-0", fields(dispatch_id="job-1:2", attempt="2")) is True
    payload = json.loads(redis.values[result_key("job-1", 2)])
    assert payload["status"] == "succeeded"
    assert payload["dispatch_id"] == "job-1:2"


@pytest.mark.asyncio
async def test_retryable_failure_at_max_attempts_is_dead_lettered(tmp_path: Path) -> None:
    redis = FakeRedis()
    adapter = FakeAdapter(error=AdapterError("lens_browser", "browser failed", retryable=True))
    worker = StreamsWorker(redis, config(tmp_path), adapter)

    assert await worker.process_entry("1-0", fields(dispatch_id="job-1:2", attempt="2")) is True
    payload = json.loads(redis.values[result_key("job-1", 2)])
    assert payload["error"]["dead_letter"] is True


@pytest.mark.asyncio
async def test_xautoclaim_entries_are_processed(tmp_path: Path) -> None:
    redis = FakeRedis()
    redis.pending = [("2-0", fields())]
    adapter = FakeAdapter(snapshot=success_snapshot())
    worker = StreamsWorker(redis, config(tmp_path), adapter)

    assert await worker.reclaim_pending() == 1
    assert redis.acks == ["2-0"]


@pytest.mark.asyncio
async def test_challenge_is_terminal_and_is_not_retried(tmp_path: Path) -> None:
    from scrapling.parser import Selector
    from scrapling_worker.parser import snapshot_from_page

    redis = FakeRedis()
    snapshot = snapshot_from_page(
        Selector(
            content=b"<main><h1>Verify you are human</h1><p>Robot check</p></main>",
            url="fixture://challenge",
        )
    )
    adapter = FakeAdapter(snapshot=snapshot)
    worker = StreamsWorker(redis, config(tmp_path), adapter)

    assert await worker.process_entry("3-0", fields()) is True

    payload = json.loads(redis.values[result_key("job-1")])
    assert payload["status"] == "failed"
    assert payload["error"]["code"] == "lens_challenge"
    assert payload["error"]["retryable"] is False
    assert redis.acks == ["3-0"]
