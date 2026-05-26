"""
Parse OMB benchmark results from Job log lines.

OMB writes the full result JSON to a file (--output path), not to stdout.
stdout contains per-second stat lines and a final aggregate summary line.

Strategy 1: Look for a bare JSON line with 'publishRate' (future-proof).
Strategy 2: Parse the 'Aggregated Pub Latency' summary line + per-second stats.
"""
import json
import re
import statistics
from typing import Optional

# Per-second stat line:
# Pub rate 12345 msg/s / 11.77 MB/s | Cons rate ... | Backlog: 0.0 K | ...
_PUB_STAT_RE = re.compile(
    r'Pub rate\s+([\d,.]+)\s*msg/s'
    r'.*?Cons rate\s+([\d,.]+)\s*msg/s'
    r'.*?Backlog:\s*(-?[\d,.]+)'
)

# Final aggregate summary line printed once at end of test (warmup excluded):
# ----- Aggregated Pub Latency (ms) avg: X - 50%: X - 95%: X - 99%: X - 99.9%: X - 99.99%: X - Max: X
#   | Pub Delay (us)  avg: X - 50%: X - 95%: X - 99%: X - 99.9%: X - 99.99%: X - Max: X
_AGG_PUB_RE = re.compile(
    r'Aggregated Pub Latency \(ms\)'
    r'.*?avg:\s*([\d,.]+)'
    r'.*?50%:\s*([\d,.]+)'
    r'.*?95%:\s*([\d,.]+)'
    r'.*?99%:\s*([\d,.]+)'
    r'.*?99\.9%:\s*([\d,.]+)'
    r'.*?99\.99%:\s*([\d,.]+)'
    r'.*?Max:\s*([\d,.]+)'
)


def _num(s: str) -> float:
    return float(s.replace(',', ''))


def parse_result_from_logs(lines: list[str]) -> Optional[dict]:
    """
    Parse OMB result metrics from log lines.

    Tries two strategies in order and returns the first that succeeds.
    """
    # Strategy 1: bare JSON line with publishRate (original approach)
    for line in reversed(lines):
        stripped = line.strip()
        if not stripped.startswith("{"):
            continue
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if "publishRate" in data:
            return _extract_metrics_from_json(data)

    # Strategy 2: parse aggregate summary + per-second stat lines
    return _extract_metrics_from_log_lines(lines)


def _extract_metrics_from_json(data: dict) -> dict:
    """Extract metrics from the OMB result JSON (written to the output file)."""

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


def _extract_metrics_from_log_lines(lines: list[str]) -> Optional[dict]:
    """
    Parse metrics from OMB stdout log lines.

    Collects per-second throughput/backlog values and extracts the
    single aggregate latency summary line printed at the end.
    """
    pub_rates: list[float] = []
    cons_rates: list[float] = []
    backlogs: list[float] = []
    agg_pub: Optional[tuple] = None

    for line in lines:
        m = _PUB_STAT_RE.search(line)
        if m:
            pub_rates.append(_num(m.group(1)))
            cons_rates.append(_num(m.group(2)))
            backlogs.append(_num(m.group(3)))

        m = _AGG_PUB_RE.search(line)
        if m:
            agg_pub = m.groups()

    # Require the aggregate summary line — it only appears on clean completion
    if not agg_pub or not pub_rates:
        return None

    def avg(lst):
        return statistics.mean(lst) if lst else None

    return {
        "publish_rate_avg": avg(pub_rates),
        "publish_latency_avg": _num(agg_pub[0]),
        "publish_latency_p50": _num(agg_pub[1]),
        "publish_latency_p75": None,
        "publish_latency_p95": _num(agg_pub[2]),
        "publish_latency_p99": _num(agg_pub[3]),
        "publish_latency_p999": _num(agg_pub[4]),
        "publish_latency_p9999": _num(agg_pub[5]),
        "publish_latency_max": _num(agg_pub[6]),
        # OMB only logs per-second E2E latency lines; there is no aggregated
        # E2E summary line to parse. "Pub Delay (us)" is producer-side batching
        # delay, not end-to-end latency, so we leave these fields as None.
        "end_to_end_latency_avg": None,
        "end_to_end_latency_p50": None,
        "end_to_end_latency_p75": None,
        "end_to_end_latency_p95": None,
        "end_to_end_latency_p99": None,
        "end_to_end_latency_p999": None,
        "end_to_end_latency_p9999": None,
        "end_to_end_latency_max": None,
        "consume_rate_avg": avg(cons_rates),
        "backlog_avg": avg(backlogs),
        "backlog_timeseries": json.dumps({"backlog": backlogs, "sample_rate_ms": 1000}),
        "throughput_timeseries": json.dumps({
            "publish_rate": pub_rates,
            "consume_rate": cons_rates,
            "sample_rate_ms": 1000,
        }),
    }
