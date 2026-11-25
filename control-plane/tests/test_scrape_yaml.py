import yaml


def test_self_hosted_scrape_job_uses_public_metrics():
    from routers.settings import _build_scrape_yaml

    out = _build_scrape_yaml(
        {"mode": "self-hosted", "scrape_targets_str": "10.0.0.1:9644, 10.0.0.2:9644"}
    )
    jobs = yaml.safe_load(out)

    assert len(jobs) == 1
    assert jobs[0]["job_name"] == "redpanda"
    assert jobs[0]["metrics_path"] == "/public_metrics"
    assert jobs[0]["static_configs"] == [{"targets": ["10.0.0.1:9644", "10.0.0.2:9644"]}]


def test_self_hosted_without_targets_clears_secret():
    from routers.settings import _build_scrape_yaml

    assert _build_scrape_yaml({"mode": "self-hosted", "scrape_targets_str": ""}) == ""
