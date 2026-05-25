"""
Collect Prometheus metrics for a completed benchmark run.

Queries the in-cluster Prometheus for Redpanda byte-rate metrics over the
run's time window and stores them as PrometheusSample rows.  All failures
are non-fatal — Prometheus data is optional context, not critical run data.
"""
import logging
from datetime import datetime
from typing import Optional

import httpx

from config import settings
from database import AsyncSessionLocal
from models import PrometheusSample

logger = logging.getLogger(__name__)

_STEP_SECONDS = 60

# Redpanda Prometheus metrics for produce and fetch byte rates.
_BYTES_IN_QUERY = (
    'sum(rate(redpanda_kafka_request_bytes_total{request_type="produce"}[1m]))'
)
_BYTES_OUT_QUERY = (
    'sum(rate(redpanda_kafka_request_bytes_total{request_type="fetch"}[1m]))'
)


async def collect_prometheus_samples(
    run_id: int,
    started_at: datetime,
    completed_at: datetime,
) -> None:
    """
    Query in-cluster Prometheus for Redpanda byte-rate metrics over the run
    window and persist them as PrometheusSample rows.

    No-ops if PROMETHEUS_URL is not configured or Prometheus is unreachable.
    """
    prometheus_url = settings.prometheus_url.rstrip("/")
    if not prometheus_url:
        logger.debug(
            "PROMETHEUS_URL not configured — skipping Prometheus sample collection "
            "for run %d",
            run_id,
        )
        return

    start_ts = started_at.timestamp()
    end_ts = completed_at.timestamp()

    if end_ts <= start_ts:
        logger.debug("Run %d has zero-length window — skipping sample collection", run_id)
        return

    try:
        bytes_in = await _query_range(prometheus_url, _BYTES_IN_QUERY, start_ts, end_ts)
        bytes_out = await _query_range(prometheus_url, _BYTES_OUT_QUERY, start_ts, end_ts)
    except Exception as exc:
        logger.warning(
            "Prometheus query failed for run %d (non-fatal): %s", run_id, exc
        )
        return

    if not bytes_in and not bytes_out:
        logger.debug("No Prometheus data returned for run %d", run_id)
        return

    all_ts = sorted(set(list(bytes_in.keys()) + list(bytes_out.keys())))
    samples = [
        PrometheusSample(
            run_id=run_id,
            t=int(ts - start_ts),
            bytes_in_per_sec=bytes_in.get(ts),
            bytes_out_per_sec=bytes_out.get(ts),
        )
        for ts in all_ts
    ]

    async with AsyncSessionLocal() as db:
        db.add_all(samples)
        await db.commit()

    logger.info("Stored %d Prometheus samples for run %d", len(samples), run_id)


async def _query_range(
    prometheus_url: str,
    query: str,
    start: float,
    end: float,
) -> dict[float, Optional[float]]:
    """Execute a Prometheus range query; return {timestamp: value} or {}."""
    params = {"query": query, "start": start, "end": end, "step": _STEP_SECONDS}
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(f"{prometheus_url}/api/v1/query_range", params=params)

    if response.status_code != 200:
        logger.warning(
            "Prometheus query_range returned HTTP %d for query: %s",
            response.status_code,
            query,
        )
        return {}

    data = response.json()
    if data.get("status") != "success":
        return {}

    result: dict[float, Optional[float]] = {}
    for series in data.get("data", {}).get("result", []):
        for ts_str, val_str in series.get("values", []):
            try:
                result[float(ts_str)] = float(val_str)
            except (ValueError, TypeError):
                pass

    return result
