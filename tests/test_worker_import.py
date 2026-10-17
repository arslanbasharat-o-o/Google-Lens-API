from scrapling_worker.config import WorkerConfig


def test_worker_config_defaults_to_disabled_live_mode() -> None:
    config = WorkerConfig.from_env({})

    assert config.mode == "disabled"
    assert config.live_enabled is False
    assert config.live_authorized is False
    assert config.stream_name == "lens:jobs:v1"
    assert config.group_name == "scrapling-workers"
