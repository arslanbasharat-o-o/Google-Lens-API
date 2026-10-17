"""Console entry point for the dedicated Scrapling worker."""

from __future__ import annotations

import asyncio
import logging
import signal

from redis.asyncio import Redis

from .config import WorkerConfig
from .worker import StreamsWorker, WorkerLogger, build_adapter


def main() -> None:
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        return


async def _run() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(message)s",
    )
    try:
        config = WorkerConfig.from_env()
        adapter = build_adapter(config)
    except (RuntimeError, ValueError) as exc:
        raise SystemExit(f"scrapling-worker configuration error: {exc}") from exc
    redis = Redis.from_url(config.redis_url, decode_responses=False)
    worker = StreamsWorker(redis, config, adapter, logger=WorkerLogger())
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, worker.stop)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        await worker.run()
    finally:
        await redis.aclose()


if __name__ == "__main__":
    main()
