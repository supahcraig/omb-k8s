"""
Parse OMB benchmark results from Job log lines.

The OMB benchmark writes a JSON result line to stdout at the end of the run
containing keys like "publishRate", "consumeRate", etc.
"""
import json
import statistics
from typing import Optional


def parse_result_from_logs(lines: list[str]) -> Optional[dict]:
    """
    Parse OMB result metrics from log lines.

    Looks for a JSON line containing 'publishRate' (the OMB result JSON).
    Returns a dict matching the Metrics model fields, or None if not found.
    """
    # Iterate in reverse — result JSON is usually near the end
    for line in reversed(lines):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "publishRate" not in data:
            continue
        return _extract_metrics(data)

    return None


def _extract_metrics(data: dict) -> dict:
    """Extract and average metrics from the OMB JSON result."""

    def avg(lst):
        return statistics.mean(lst) if lst else None

    return {
        "publish_rate_avg": avg(data.get("publishRate", [])),
        "publish_latency_avg": data.get("aggregatedPublishLatencyAvg"),
        "publish_latency_p50": data.get("aggregatedPublishLatency50pct"),
        "publish_latency_p75": data.get("aggregatedPublishLatency75pct"),
        "publish_latency_p95": data.get("aggregatedPublishLatency95pct"),
        "publish_latency_p99": data.get("aggregatedPublishLatency99pct"),
        "publish_latency_p999": data.get("aggregatedPublishLatency999pct"),
        "publish_latency_p9999": data.get("aggregatedPublishLatency9999pct"),
        "publish_latency_max": data.get("aggregatedPublishLatencyMax"),
        "end_to_end_latency_avg": data.get("aggregatedEndToEndLatencyAvg"),
        "end_to_end_latency_p50": data.get("aggregatedEndToEndLatency50pct"),
        "end_to_end_latency_p75": data.get("aggregatedEndToEndLatency75pct"),
        "end_to_end_latency_p95": data.get("aggregatedEndToEndLatency95pct"),
        "end_to_end_latency_p99": data.get("aggregatedEndToEndLatency99pct"),
        "end_to_end_latency_p999": data.get("aggregatedEndToEndLatency999pct"),
        "end_to_end_latency_p9999": data.get("aggregatedEndToEndLatency9999pct"),
        "end_to_end_latency_max": data.get("aggregatedEndToEndLatencyMax"),
        "consume_rate_avg": avg(data.get("consumeRate", [])),
        "backlog_avg": avg(data.get("backlog", [])),
        "backlog_timeseries": json.dumps({
            "backlog": data.get("backlog", []),
            "sample_rate_ms": data.get("sampleRateMillis", 1000),
        }),
        "throughput_timeseries": json.dumps({
            "publish_rate": data.get("publishRate", []),
            "consume_rate": data.get("consumeRate", []),
            "sample_rate_ms": data.get("sampleRateMillis", 1000),
        }),
    }
