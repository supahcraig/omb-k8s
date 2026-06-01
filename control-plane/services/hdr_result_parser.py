"""
Parse OMB HDR result files and store aggregated percentile data to the DB.
"""
import asyncio
import glob
import json
import logging
from datetime import datetime
from typing import Optional

from database import AsyncSessionLocal
from models import RunResult

logger = logging.getLogger(__name__)

RESULTS_DIR = "/data/results"


def _find_result_file(run_id: int) -> Optional[str]:
    """Return path to the result file for run_id, checking both naming patterns."""
    for pattern in (
        f"{RESULTS_DIR}/run-{run_id}.json",
        f"{RESULTS_DIR}/sweep-*-run-{run_id}.json",
    ):
        matches = glob.glob(pattern)
        if matches:
            return matches[0]
    return None


def _thin_quantiles(
    quantiles: dict, min_pct: float = 50.0, step: int = 10
) -> list[dict]:
    """
    Filter to >= min_pct, sort by percentile, return every step-th entry.
    Returns [{percentile: float, latencyMs: float}].
    """
    pairs = []
    for k, v in quantiles.items():
        try:
            pct = float(k)
        except ValueError:
            continue
        if pct >= min_pct:
            pairs.append((pct, float(v)))
    pairs.sort(key=lambda x: x[0])
    return [{"percentile": pct, "latencyMs": ms} for pct, ms in pairs[::step]]


def _build_histogram(curve: list[dict], num_buckets: int = 30) -> list[dict]:
    """
    Build equal-width latency histogram from thinned curve data.
    Each point is treated as one sample; buckets count how many points fall in each range.
    Returns [{bucketLabel: str, percentage: float}].
    """
    if not curve:
        return []
    values = [p["latencyMs"] for p in curve]
    lo, hi = min(values), max(values)
    if lo == hi:
        return [{"bucketLabel": f"{lo:.2f}", "percentage": 100.0}]
    width = (hi - lo) / num_buckets
    counts = [0] * num_buckets
    for v in values:
        idx = min(int((v - lo) / width), num_buckets - 1)
        counts[idx] += 1
    total = len(values)
    return [
        {
            "bucketLabel": f"{lo + i * width:.2f}",
            "percentage": round(c / total * 100, 3),
        }
        for i, c in enumerate(counts)
    ]


def parse_hdr_results_from_file(path: str) -> Optional[dict]:
    """
    Read the OMB result JSON file and return the structured API response dict.
    Returns None if the file is missing, unreadable, or not an OMB result.
    """
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception as exc:
        logger.warning("Failed to read result file %s: %s", path, exc)
        return None

    if "publishRate" not in data:
        return None

    pub_q_raw = data.get("aggregatedPublishLatencyQuantiles") or {}
    e2e_q_raw = data.get("aggregatedEndToEndLatencyQuantiles") or {}
    pub_curve = _thin_quantiles(pub_q_raw)
    e2e_curve = _thin_quantiles(e2e_q_raw)

    return {
        "metadata": {
            "beginTime":         data.get("beginTime"),
            "endTime":           data.get("endTime"),
            "messageSize":       data.get("messageSize"),
            "topics":            data.get("topics"),
            "partitions":        data.get("partitions"),
            "producersPerTopic": data.get("producersPerTopic"),
            "consumersPerTopic": data.get("consumersPerTopic"),
            "driver":            data.get("driver"),
            "sampleRateMillis":  data.get("sampleRateMillis"),
        },
        "aggregates": {
            "publish": {
                "avg":   data.get("aggregatedPublishLatencyAvg"),
                "p50":   data.get("aggregatedPublishLatency50pct"),
                "p75":   data.get("aggregatedPublishLatency75pct"),
                "p95":   data.get("aggregatedPublishLatency95pct"),
                "p99":   data.get("aggregatedPublishLatency99pct"),
                "p999":  data.get("aggregatedPublishLatency999pct"),
                "p9999": data.get("aggregatedPublishLatency9999pct"),
                "max":   data.get("aggregatedPublishLatencyMax"),
            },
            "endToEnd": {
                "avg":   data.get("aggregatedEndToEndLatencyAvg"),
                "p50":   data.get("aggregatedEndToEndLatency50pct"),
                "p75":   data.get("aggregatedEndToEndLatency75pct"),
                "p95":   data.get("aggregatedEndToEndLatency95pct"),
                "p99":   data.get("aggregatedEndToEndLatency99pct"),
                "p999":  data.get("aggregatedEndToEndLatency999pct"),
                "p9999": data.get("aggregatedEndToEndLatency9999pct"),
                "max":   data.get("aggregatedEndToEndLatencyMax"),
            },
        },
        "percentileCurves": {
            "publish":  pub_curve,
            "endToEnd": e2e_curve,
        },
        "histograms": {
            "publish":  _build_histogram(pub_curve),
            "endToEnd": _build_histogram(e2e_curve),
        },
        "timeSeries": {
            "publishRate":         data.get("publishRate", []),
            "consumeRate":         data.get("consumeRate", []),
            "backlog":             data.get("backlog", []),
            "publishLatencyP50":   data.get("publishLatency50pct", []),
            "publishLatencyP99":   data.get("publishLatency99pct", []),
            "publishLatencyP999":  data.get("publishLatency999pct", []),
            "endToEndLatencyP50":  data.get("endToEndLatency50pct", []),
            "endToEndLatencyP99":  data.get("endToEndLatency99pct", []),
            "endToEndLatencyP999": data.get("endToEndLatency999pct", []),
        },
    }


async def parse_and_store_hdr_results(
    run_id: int, max_retries: int = 5, retry_delay: float = 2.0
) -> bool:
    """
    Find, parse, and store HDR results for run_id. Retries if file not found.
    Skips silently if row already exists. Returns True on success.
    """
    path = None
    for attempt in range(max_retries):
        path = _find_result_file(run_id)
        if path:
            break
        logger.debug(
            "HDR parse: file not found for run %d (attempt %d/%d)",
            run_id, attempt + 1, max_retries,
        )
        await asyncio.sleep(retry_delay)

    if not path:
        logger.warning(
            "HDR parse: result file not found for run %d after %d retries",
            run_id, max_retries,
        )
        return False

    parsed = parse_hdr_results_from_file(path)
    if not parsed:
        logger.warning("HDR parse: could not parse result file for run %d at %s", run_id, path)
        return False

    agg = parsed["aggregates"]
    pub = agg["publish"]
    e2e = agg["endToEnd"]
    curves = parsed["percentileCurves"]

    async with AsyncSessionLocal() as db:
        existing = await db.get(RunResult, run_id)
        if existing:
            return True
        row = RunResult(
            run_id=run_id,
            publish_p50=pub.get("p50"),
            publish_p75=pub.get("p75"),
            publish_p95=pub.get("p95"),
            publish_p99=pub.get("p99"),
            publish_p999=pub.get("p999"),
            publish_p9999=pub.get("p9999"),
            publish_max=pub.get("max"),
            publish_avg=pub.get("avg"),
            e2e_p50=e2e.get("p50"),
            e2e_p75=e2e.get("p75"),
            e2e_p95=e2e.get("p95"),
            e2e_p99=e2e.get("p99"),
            e2e_p999=e2e.get("p999"),
            e2e_p9999=e2e.get("p9999"),
            e2e_max=e2e.get("max"),
            e2e_avg=e2e.get("avg"),
            publish_quantiles_json=json.dumps(curves["publish"]),
            e2e_quantiles_json=json.dumps(curves["endToEnd"]),
            parsed_at=datetime.utcnow(),
        )
        db.add(row)
        try:
            await db.commit()
        except Exception as exc:
            await db.rollback()
            logger.error("HDR parse: DB commit failed for run %d: %s", run_id, exc)
            return False

    logger.info("HDR parse: stored results for run %d from %s", run_id, path)
    return True
