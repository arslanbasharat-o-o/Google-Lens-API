import pytest

from scrapling_worker.config import WorkerConfig


def test_worker_config_defaults_to_disabled_live_mode() -> None:
    config = WorkerConfig.from_env({})

    assert config.mode == "disabled"
    assert config.live_enabled is False
    assert config.live_authorized is False
    assert config.stream_name == "lens:jobs:v1"
    assert config.group_name == "scrapling-workers"


def test_live_mode_requires_the_explicit_authorization_phrase() -> None:
    with pytest.raises(ValueError):
        WorkerConfig.from_env({
            "SCRAPLING_WORKER_MODE": "live",
            "GOOGLE_LENS_LIVE_ENABLED": "true",
            "GOOGLE_LENS_LIVE_AUTHORIZED": "true",
        })

    config = WorkerConfig.from_env({
        "SCRAPLING_WORKER_MODE": "live",
        "GOOGLE_LENS_LIVE_ENABLED": "true",
        "GOOGLE_LENS_LIVE_AUTHORIZED": "I_UNDERSTAND_AND_AUTHORIZE",
    })
    assert config.live_gate_open is True
