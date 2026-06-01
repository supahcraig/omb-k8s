import json
import os
import tempfile

import pytest

from services.hdr_result_parser import (
    _build_histogram,
    _find_result_file,
    _thin_quantiles,
    parse_hdr_results_from_file,
)


def _make_result_file(path: str, extra: dict = None):
    data = {
        "publishRate": [10000.0, 10100.0],
        "consumeRate": [10000.0, 10100.0],
        "backlog": [0.0, 0.0],
        "publishLatency50pct": [3.0, 3.1],
        "publishLatency99pct": [8.2, 8.3],
        "publishLatency999pct": [15.0, 15.1],
        "endToEndLatency50pct": [3.5, 3.6],
        "endToEndLatency99pct": [9.1, 9.2],
        "endToEndLatency999pct": [18.0, 18.1],
        "aggregatedPublishLatencyAvg": 3.5,
        "aggregatedPublishLatency50pct": 3.3,
        "aggregatedPublishLatency75pct": 4.1,
        "aggregatedPublishLatency95pct": 5.6,
        "aggregatedPublishLatency99pct": 8.2,
        "aggregatedPublishLatency999pct": 15.4,
        "aggregatedPublishLatency9999pct": 22.1,
        "aggregatedPublishLatencyMax": 33.9,
        "aggregatedEndToEndLatencyAvg": 4.2,
        "aggregatedEndToEndLatency50pct": 3.9,
        "aggregatedEndToEndLatency75pct": 4.7,
        "aggregatedEndToEndLatency95pct": 6.5,
        "aggregatedEndToEndLatency99pct": 9.4,
        "aggregatedEndToEndLatency999pct": 23.6,
        "aggregatedEndToEndLatency9999pct": 28.9,
        "aggregatedEndToEndLatencyMax": 33.9,
        "aggregatedPublishLatencyQuantiles": {
            str(50.0 + i * 0.5): 3.0 + i * 0.05
            for i in range(100)
        },
        "aggregatedEndToEndLatencyQuantiles": {
            str(50.0 + i * 0.5): 3.5 + i * 0.06
            for i in range(100)
        },
        "beginTime": "2024-01-01T00:00:00",
        "endTime": "2024-01-01T00:05:00",
        "messageSize": 1024,
        "topics": 1,
        "partitions": 32,
        "producersPerTopic": 4,
        "consumersPerTopic": 1,
        "driver": "Redpanda",
    }
    if extra:
        data.update(extra)
    with open(path, "w") as f:
        json.dump(data, f)


def test_thin_quantiles_filters_below_50():
    quantiles = {"40.0": 2.0, "50.0": 3.0, "90.0": 5.0, "99.0": 8.0}
    result = _thin_quantiles(quantiles)
    percentiles = [p["percentile"] for p in result]
    assert 40.0 not in percentiles
    assert 50.0 in percentiles


def test_thin_quantiles_sorted():
    quantiles = {"99.0": 8.0, "50.0": 3.0, "75.0": 5.0}
    result = _thin_quantiles(quantiles)
    pcts = [p["percentile"] for p in result]
    assert pcts == sorted(pcts)


def test_thin_quantiles_every_10th():
    quantiles = {str(50.0 + i): float(i) for i in range(50)}
    result = _thin_quantiles(quantiles, step=10)
    assert len(result) == 5  # indices 0, 10, 20, 30, 40


def test_build_histogram_returns_30_buckets():
    pairs = [{"percentile": 50.0 + i, "latencyMs": float(i)} for i in range(50)]
    result = _build_histogram(pairs)
    assert len(result) == 30


def test_build_histogram_percentages_sum_to_100():
    pairs = [{"percentile": 50.0 + i, "latencyMs": float(i)} for i in range(100)]
    result = _build_histogram(pairs)
    total = sum(b["percentage"] for b in result)
    assert abs(total - 100.0) < 1.0  # allow rounding error


def test_parse_hdr_results_from_file_returns_all_sections():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        path = f.name
    try:
        _make_result_file(path)
        result = parse_hdr_results_from_file(path)
        assert result is not None
        assert "metadata" in result
        assert "aggregates" in result
        assert "percentileCurves" in result
        assert "histograms" in result
        assert "timeSeries" in result
        assert result["aggregates"]["publish"]["p99"] == 8.2
        assert result["aggregates"]["endToEnd"]["p99"] == 9.4
        assert len(result["percentileCurves"]["publish"]) > 0
        assert len(result["histograms"]["publish"]) == 30
    finally:
        os.unlink(path)


def test_parse_hdr_results_timeseries_includes_p50():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        path = f.name
    try:
        _make_result_file(path)
        result = parse_hdr_results_from_file(path)
        assert result is not None
        ts = result["timeSeries"]
        assert "publishLatencyP50"  in ts
        assert "endToEndLatencyP50" in ts
        assert ts["publishLatencyP50"]  == [3.0, 3.1]
        assert ts["endToEndLatencyP50"] == [3.5, 3.6]
    finally:
        os.unlink(path)


def test_parse_hdr_results_from_file_returns_none_for_invalid():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        path = f.name
        json.dump({"not_a_result": True}, f)
    try:
        result = parse_hdr_results_from_file(path)
        assert result is None
    finally:
        os.unlink(path)


def test_find_result_file_matches_single_run(tmp_path):
    import services.hdr_result_parser as mod
    original = mod.RESULTS_DIR
    mod.RESULTS_DIR = str(tmp_path)
    try:
        result_file = tmp_path / "run-42.json"
        result_file.write_text("{}")
        found = _find_result_file(42)
        assert found == str(result_file)
    finally:
        mod.RESULTS_DIR = original


def test_find_result_file_matches_sweep_run(tmp_path):
    import services.hdr_result_parser as mod
    original = mod.RESULTS_DIR
    mod.RESULTS_DIR = str(tmp_path)
    try:
        result_file = tmp_path / "sweep-5-run-42.json"
        result_file.write_text("{}")
        found = _find_result_file(42)
        assert found == str(result_file)
    finally:
        mod.RESULTS_DIR = original


def test_find_result_file_returns_none_when_missing(tmp_path):
    import services.hdr_result_parser as mod
    original = mod.RESULTS_DIR
    mod.RESULTS_DIR = str(tmp_path)
    try:
        found = _find_result_file(99)
        assert found is None
    finally:
        mod.RESULTS_DIR = original
