"""Environment-backed configuration for the isolated worker."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


def _env_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(value: str | None, default: int, *, minimum: int = 0, maximum: int | None = None) -> int:
    if value is None or not value.strip():
        result = default
    else:
        try:
            result = int(value)
        except ValueError as exc:
            raise ValueError(f"invalid integer configuration value: {value!r}") from exc
    if result < minimum:
        raise ValueError(f"configuration value must be >= {minimum}: {result}")
    if maximum is not None and result > maximum:
        raise ValueError(f"configuration value must be <= {maximum}: {result}")
    return result


@dataclass(frozen=True, slots=True)
class WorkerConfig:
    """Runtime settings with safe defaults.

    ``mode=disabled`` never constructs a browser. ``mode=fixture`` is intended
    for deterministic local runs. ``mode=live`` is accepted only when both
    explicit live gates are true.
    """

    redis_url: str = "redis://127.0.0.1:6379/0"
    stream_name: str = "lens:jobs:v1"
    group_name: str = "scrapling-workers"
    consumer_name: str = "scrapling-worker-local"
    image_storage_dir: Path = Path("/data/images")
    result_ttl_seconds: int = 3600
    attempt_ttl_seconds: int = 86400
    max_attempts: int = 3
    block_ms: int = 1000
    reclaim_idle_ms: int = 5000
    reclaim_batch: int = 10
    heartbeat_ttl_seconds: int = 60
    browser_timeout_ms: int = 30000
    max_pages: int = 1
    headless: bool = True
    target_url: str = "https://www.google.com/?olud="
    mode: str = "disabled"
    deployment_mode: str | None = None
    fixture_dir: Path = Path("scrapling_worker/fixtures")
    live_enabled: bool = False
    live_authorized: bool = False

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "WorkerConfig":
        values = os.environ if env is None else env
        host = values.get("HOSTNAME") or socket.gethostname() or "local"
        safe_host = "".join(character if character.isalnum() or character in "-_." else "-" for character in host)
        consumer_name = values.get("SCRAPLING_CONSUMER_NAME", f"scrapling-worker-{safe_host}-{os.getpid()}")
        mode = values.get("SCRAPLING_WORKER_MODE", "disabled").strip().lower()
        if mode not in {"disabled", "fixture", "live"}:
            raise ValueError("SCRAPLING_WORKER_MODE must be disabled, fixture, or live")

        deployment_mode_raw = values.get("LENS_DEPLOYMENT_MODE", "").strip().lower()
        deployment_mode = deployment_mode_raw or None
        if deployment_mode is not None and deployment_mode not in {"fixture", "live"}:
            raise ValueError("LENS_DEPLOYMENT_MODE must be fixture or live")
        if deployment_mode is not None and mode != deployment_mode:
            raise ValueError(
                "LENS_DEPLOYMENT_MODE must match SCRAPLING_WORKER_MODE "
                f"(got {deployment_mode!r} and {mode!r})"
            )

        adapter = values.get("LENS_ADAPTER", "").strip().lower()
        if adapter and adapter not in {"mock", "scrapling"}:
            raise ValueError("LENS_ADAPTER must be mock or scrapling")
        if mode in {"fixture", "live"} and adapter and adapter != "scrapling":
            raise ValueError(
                f"SCRAPLING_WORKER_MODE={mode} requires LENS_ADAPTER=scrapling"
            )
        if mode == "disabled" and adapter == "scrapling":
            raise ValueError(
                "SCRAPLING_WORKER_MODE=disabled cannot be used with "
                "LENS_ADAPTER=scrapling; select fixture or live"
            )

        live_enabled = _env_bool(values.get("GOOGLE_LENS_LIVE_ENABLED"))
        raw_live_authorized = values.get("GOOGLE_LENS_LIVE_AUTHORIZED", "").strip()
        live_authorized = raw_live_authorized == "I_UNDERSTAND_AND_AUTHORIZE"
        if mode != "live" and (
            live_enabled
            or raw_live_authorized.lower() not in {"", "false", "0", "no", "off"}
        ):
            raise ValueError(
                "Google Lens live authorization variables require "
                "SCRAPLING_WORKER_MODE=live"
            )
        if mode == "live" and not (live_enabled and live_authorized):
            raise ValueError(
                "live Scrapling mode requires GOOGLE_LENS_LIVE_ENABLED=true and "
                "GOOGLE_LENS_LIVE_AUTHORIZED=I_UNDERSTAND_AND_AUTHORIZE"
            )

        return cls(
            redis_url=values.get("REDIS_URL", "redis://127.0.0.1:6379/0"),
            stream_name=values.get("LENS_JOB_STREAM", "lens:jobs:v1"),
            group_name=values.get("LENS_CONSUMER_GROUP", "scrapling-workers"),
            consumer_name=consumer_name,
            image_storage_dir=Path(values.get("IMAGE_STORAGE_DIR", "/data/images")),
            result_ttl_seconds=_env_int(values.get("LENS_RESULT_TTL_SECONDS"), 3600, minimum=1),
            attempt_ttl_seconds=_env_int(values.get("LENS_ATTEMPT_TTL_SECONDS"), 86400, minimum=1),
            max_attempts=_env_int(values.get("LENS_MAX_ATTEMPTS"), 3, minimum=1, maximum=10),
            block_ms=_env_int(values.get("LENS_BLOCK_MS"), 1000, minimum=100),
            reclaim_idle_ms=_env_int(values.get("LENS_RECLAIM_IDLE_MS"), 5000, minimum=0),
            reclaim_batch=_env_int(values.get("LENS_RECLAIM_BATCH"), 10, minimum=1, maximum=100),
            heartbeat_ttl_seconds=_env_int(
                values.get("SCRAPLING_HEARTBEAT_TTL_SECONDS")
                or values.get("LENS_HEARTBEAT_TTL_SECONDS"),
                60,
                minimum=10,
            ),
            browser_timeout_ms=_env_int(values.get("SCRAPLING_BROWSER_TIMEOUT_MS"), 30000, minimum=1000),
            max_pages=_env_int(values.get("SCRAPLING_MAX_PAGES"), 1, minimum=1, maximum=50),
            headless=_env_bool(values.get("SCRAPLING_HEADLESS"), default=True),
            target_url=values.get("GOOGLE_LENS_TARGET_URL", "https://www.google.com/?olud="),
            mode=mode,
            deployment_mode=deployment_mode,
            fixture_dir=Path(values.get("SCRAPLING_FIXTURE_DIR", "scrapling_worker/fixtures")),
            live_enabled=live_enabled,
            live_authorized=live_authorized,
        )

    @property
    def live_gate_open(self) -> bool:
        """Whether both explicit live gates are open."""

        return self.live_enabled and self.live_authorized
