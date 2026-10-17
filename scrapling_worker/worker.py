"""Redis Streams worker lifecycle, retries, reclaim, and idempotent results."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from redis.exceptions import ResponseError

from .adapters import AdapterError, PageAdapter
from .config import WorkerConfig
from .contract import (
    ContractError,
    StreamJob,
    cancellation_key,
    result_key,
    WORKER_HEARTBEAT_KEY,
)
from .parser import LensParseError, result_from_snapshot


class RedisStreamClient(Protocol):
    async def xgroup_create(self, name: str, groupname: str, id: str = "0-0", mkstream: bool = False) -> Any: ...

    async def xreadgroup(self, groupname: str, consumername: str, streams: Mapping[str, str], **kwargs: Any) -> Any: ...

    async def xautoclaim(self, name: str, groupname: str, consumername: str, min_idle_time: int, **kwargs: Any) -> Any: ...

    async def xack(self, name: str, groupname: str, *ids: str) -> Any: ...

    async def get(self, name: str) -> Any: ...

    async def setex(self, name: str, time: int, value: str) -> Any: ...

    async def incr(self, name: str) -> Any: ...

    async def expire(self, name: str, time: int) -> Any: ...


class WorkerLogger:
    """JSON logger that never includes image bytes, paths, or result URLs."""

    def __init__(self, logger: logging.Logger | None = None) -> None:
        self.logger = logger or logging.getLogger("scrapling-worker")

    def event(self, name: str, *, job_id: str | None = None, **fields: Any) -> None:
        payload: dict[str, Any] = {"event": name, **fields}
        if job_id:
            payload["job_id"] = hashlib.sha256(job_id.encode("utf-8")).hexdigest()[:12]
        self.logger.info(json.dumps(payload, sort_keys=True, separators=(",", ":")))


class StreamsWorker:
    """One cooperative consumer for ``lens:jobs:v1``.

    The API owns the monotonic attempt number. Each stream entry carries a
    dispatch_id (job_id:attempt), and every result repeats that ownership token.
    Retryable failures are terminal for this dispatch and are re-enqueued by the
    API with the next attempt. Terminal output is written with SETEX before
    XACK, so a crash before the ACK is harmless and duplicate delivery is safe.
    """

    def __init__(
        self,
        redis: RedisStreamClient,
        config: WorkerConfig,
        adapter: PageAdapter,
        *,
        logger: WorkerLogger | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.redis = redis
        self.config = config
        self.adapter = adapter
        self.logger = logger or WorkerLogger()
        self.now = now or (lambda: datetime.now(timezone.utc))
        self._stop_event = asyncio.Event()
        self._closed = False

    async def ensure_group(self) -> None:
        try:
            await self.redis.xgroup_create(
                self.config.stream_name,
                self.config.group_name,
                id="0-0",
                mkstream=True,
            )
        except ResponseError as exc:
            if "BUSYGROUP" not in str(exc).upper():
                raise

    async def run(self) -> None:
        try:
            await self.ensure_group()
            await self._check_adapter_ready()
            self.logger.event(
                "worker_started",
                stream=self.config.stream_name,
                group=self.config.group_name,
                consumer=self.config.consumer_name,
                mode=self.config.mode,
            )
            while not self._stop_event.is_set():
                await self._heartbeat()
                await self.reclaim_pending()
                raw_entries = await self.redis.xreadgroup(
                    self.config.group_name,
                    self.config.consumer_name,
                    {self.config.stream_name: ">"},
                    count=1,
                    block=self.config.block_ms,
                )
                for entry_id, fields in _flatten_entries(raw_entries):
                    await self.process_entry(entry_id, fields)
        except asyncio.CancelledError:
            self.stop()
            raise
        finally:
            await self.close()
            self.logger.event("worker_stopped")

    async def reclaim_pending(self) -> int:
        """Claim and process idle pending entries, returning the count seen."""

        raw = await self.redis.xautoclaim(
            self.config.stream_name,
            self.config.group_name,
            self.config.consumer_name,
            self.config.reclaim_idle_ms,
            start_id="0-0",
            count=self.config.reclaim_batch,
        )
        entries = _autoclaim_entries(raw)
        for entry_id, fields in entries:
            await self.process_entry(entry_id, fields)
        if entries:
            self.logger.event("pending_reclaimed", count=len(entries))
        return len(entries)

    async def process_entry(self, entry_id: str, fields: Mapping[object, object]) -> bool:
        """Process one entry; return True when it was ACKed."""

        job_id = _field(fields, "job_id") or f"invalid-{entry_id}"
        try:
            job = StreamJob.from_fields(fields)
        except ContractError as exc:
            await self._terminal(
                entry_id,
                job_id,
                dispatch_id=_field(fields, "dispatch_id") or f"{job_id}:invalid",
                attempt=0,
                status="failed",
                error={"code": "validation_error", "message": str(exc), "retryable": False},
            )
            return True

        attempt = job.attempt
        existing = await self.redis.get(result_key(job_id, attempt))
        if existing:
            await self.redis.xack(self.config.stream_name, self.config.group_name, entry_id)
            self.logger.event("duplicate_acked", job_id=job_id, reason="result_exists", attempt=attempt)
            return True

        self.logger.event("job_started", job_id=job.job_id, attempt=attempt)

        if attempt > self.config.max_attempts:
            await self._terminal(
                entry_id,
                job.job_id,
                dispatch_id=job.dispatch_id,
                attempt=attempt,
                status="failed",
                error={
                    "code": "retry_exhausted",
                    "message": "bounded worker attempts were exhausted",
                    "retryable": False,
                    "dead_letter": True,
                },
            )
            return True

        if await self._cancelled(job.job_id):
            await self._terminal(
                entry_id,
                job.job_id,
                dispatch_id=job.dispatch_id,
                attempt=attempt,
                status="cancelled",
                error={"code": "cancelled", "message": "The search job was cancelled.", "retryable": False},
            )
            return True

        try:
            image_path = self._image_path(job.image_id)
            started_at = self.now()
            snapshot = await self.adapter.search(job, image_path)
            if await self._cancelled(job.job_id):
                await self._terminal(
                    entry_id,
                    job.job_id,
                    dispatch_id=job.dispatch_id,
                    attempt=attempt,
                    status="cancelled",
                    error={"code": "cancelled", "message": "The search job was cancelled.", "retryable": False},
                )
                return True
            processed_at = self.now()
            result = result_from_snapshot(
                job,
                snapshot,
                started_at=started_at,
                processed_at=processed_at,
                source="mock" if self.config.mode == "fixture" else "scrapling",
            )
        except (AdapterError, LensParseError) as exc:
            error = {
                "code": exc.code,
                "message": _redact_message(str(exc)),
                "retryable": exc.retryable,
            }
            if exc.retryable and attempt < self.config.max_attempts:
                self.logger.event("job_retry_pending", job_id=job.job_id, attempt=attempt, code=exc.code)
                await self._terminal(
                    entry_id,
                    job.job_id,
                    dispatch_id=job.dispatch_id,
                    attempt=attempt,
                    status="failed",
                    error={**error, "dead_letter": False},
                )
                return True
            await self._terminal(
                entry_id,
                job.job_id,
                dispatch_id=job.dispatch_id,
                attempt=attempt,
                status="failed",
                error={**error, "dead_letter": exc.retryable and attempt >= self.config.max_attempts},
            )
            return True
        except Exception:
            error = {
                "code": "lens_worker",
                "message": "worker processing failed unexpectedly",
                "retryable": True,
            }
            if attempt < self.config.max_attempts:
                self.logger.event("job_retry_pending", job_id=job.job_id, attempt=attempt, code="lens_worker")
                await self._terminal(
                    entry_id,
                    job.job_id,
                    dispatch_id=job.dispatch_id,
                    attempt=attempt,
                    status="failed",
                    error={**error, "dead_letter": False},
                )
                return True
            await self._terminal(
                entry_id,
                job.job_id,
                dispatch_id=job.dispatch_id,
                attempt=attempt,
                status="failed",
                error={**error, "dead_letter": True},
            )
            return True

        await self._terminal(
            entry_id,
            job.job_id,
            dispatch_id=job.dispatch_id,
            attempt=attempt,
            status="succeeded",
            result=result,
        )
        return True

    def stop(self) -> None:
        self._stop_event.set()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self.adapter.close()

    def _image_path(self, image_id: str) -> Path:
        root = self.config.image_storage_dir.resolve()
        candidate = (root / image_id).resolve()
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise AdapterError("image_invalid", "image_id escapes IMAGE_STORAGE_DIR", retryable=False) from exc
        if candidate == root or Path(image_id).name != image_id:
            raise AdapterError("image_invalid", "image_id must name a file in IMAGE_STORAGE_DIR", retryable=False)
        if not candidate.is_file():
            raise AdapterError("image_missing", "shared image file does not exist", retryable=False)
        return candidate

    async def _cancelled(self, job_id: str) -> bool:
        return bool(await self.redis.get(cancellation_key(job_id)))

    async def _heartbeat(self) -> None:
        await self.redis.setex(
            WORKER_HEARTBEAT_KEY,
            self.config.heartbeat_ttl_seconds,
            str(int(self.now().timestamp() * 1000)),
        )

    async def _check_adapter_ready(self) -> None:
        check_ready = getattr(self.adapter, "check_ready", None)
        if check_ready is None:
            return
        await check_ready()

    async def _terminal(
        self,
        entry_id: str,
        job_id: str,
        *,
        dispatch_id: str,
        attempt: int,
        status: str,
        result: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "schema_version": "lens.result.v1",
            "job_id": job_id,
            "dispatch_id": dispatch_id,
            "status": status,
            "attempt": attempt,
            "result": result,
            "error": error,
        }
        # SETEX must complete before this ACK. A failed write leaves the entry
        # pending and allows XAUTOCLAIM to recover it after a restart.
        await self.redis.setex(
            result_key(job_id, attempt),
            self.config.result_ttl_seconds,
            json.dumps(payload, sort_keys=True, separators=(",", ":")),
        )
        await self.redis.xack(self.config.stream_name, self.config.group_name, entry_id)
        self.logger.event("job_terminal", job_id=job_id, attempt=attempt, status=status)


def build_adapter(config: WorkerConfig) -> PageAdapter:
    """Select an adapter without importing browser fetchers in safe modes."""

    if config.mode == "fixture":
        from .adapters import FixturePageAdapter

        return FixturePageAdapter(config.fixture_dir)
    if config.mode == "live":
        from .adapters import ScraplingLensAdapter

        return ScraplingLensAdapter(config)
    raise RuntimeError("SCRAPLING_WORKER_MODE=disabled; select fixture or explicitly gated live mode")


def _field(fields: Mapping[object, object], name: str) -> str | None:
    for key, value in fields.items():
        key_text = key.decode("utf-8", errors="replace") if isinstance(key, bytes) else str(key)
        if key_text == name:
            if isinstance(value, bytes):
                return value.decode("utf-8", errors="replace")
            return str(value)
    return None


def _flatten_entries(raw: Any) -> list[tuple[str, Mapping[object, object]]]:
    if not raw:
        return []
    entries: list[tuple[str, Mapping[object, object]]] = []
    for _stream, messages in raw:
        for entry_id, fields in messages:
            entries.append((_to_text(entry_id), fields))
    return entries


def _autoclaim_entries(raw: Any) -> list[tuple[str, Mapping[object, object]]]:
    if not raw or len(raw) < 2:
        return []
    return [(_to_text(entry_id), fields) for entry_id, fields in raw[1]]


def _to_text(value: object) -> str:
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value)


def _redact_message(message: str) -> str:
    redacted = re.sub(r"https?://[^\s]+", "<url>", message)
    redacted = re.sub(r"(?:/Users|/home|/data|/tmp)/[^\s]+", "<path>", redacted)
    return redacted[:240]
