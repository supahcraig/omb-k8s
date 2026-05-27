"""
Background Prometheus collector — polls worker resource metrics every 15 s
during a benchmark run and writes them to prometheus_samples.

Queries the in-cluster Prometheus (kube-prometheus-stack) for cAdvisor
metrics on omb-worker-* pods. Silently no-ops if Prometheus is unreachable
so a missing Prometheus deployment never breaks a benchmark run.
"""
import asyncio
import logging
import math
from typing import Optional

import httpx

from database import AsyncSessionLocal
from models import PrometheusSample
from services.omb_runner import runner

logger = logging.getLogger(__name__)

POLL_INTERVAL = 15  # seconds between samples
CPU_LIMIT_CORES = 4.0  # worker pods are always 4 vCPU per CLAUDE.md


async def _query(client: httpx.AsyncClient, base_url: str, query: str) -> Optional[float]:
    """Execute an instant PromQL query and return the first scalar value."""
    try:
        resp = await client.get(f"{base_url}/api/v1/query", params={"query": query}, timeout=8.0)
        if resp.status_code != 200:
            return None
        results = resp.json().get("data", {}).get("result", [])
        if not results:
            return None
        val = float(results[0]["value"][1])
        return None if math.isnan(val) or math.isinf(val) else val
    except Exception as exc:
        logger.debug("Prometheus query error: %s", exc)
        return None


async def collect_prometheus(run_id: int, namespace: str, prom_url: str) -> None:
    """
    Poll Prometheus every POLL_INTERVAL seconds until the run finishes.
    Writes one PrometheusSample row per interval.
    """
    if not prom_url:
        logger.debug("No Prometheus URL configured — skipping collection for run %d", run_id)
        return

    logger.info("Starting Prometheus collection for run %d → %s", run_id, prom_url)
    t = 0

    async with httpx.AsyncClient() as client:
        while not runner.is_done(run_id):
            await asyncio.sleep(POLL_INTERVAL)
            t += POLL_INTERVAL

            if runner.is_done(run_id):
                break

            ns = namespace
            worker_selector = f'namespace="{ns}",pod=~"omb-worker-.*",container="worker"'

            cpu_pct = await _query(client, prom_url,
                f'100 * avg(rate(container_cpu_usage_seconds_total{{{worker_selector}}}[2m]))'
                f' / {CPU_LIMIT_CORES}')

            memory_mib = await _query(client, prom_url,
                f'avg(container_memory_working_set_bytes{{{worker_selector}}}) / 1048576')

            # Throttle: fraction of CFS periods that were throttled (→ %)
            # Returns NaN early in the run before the rate window fills;
            # _query() converts NaN → None automatically.
            throttle_pct = await _query(client, prom_url,
                f'100 * max('
                f'  rate(container_cpu_cfs_throttled_periods_total{{{worker_selector}}}[2m])'
                f'  / rate(container_cpu_cfs_periods_total{{{worker_selector}}}[2m])'
                f')')

            async with AsyncSessionLocal() as db:
                sample = PrometheusSample(
                    run_id=run_id,
                    t=t,
                    bytes_in_per_sec=None,
                    bytes_out_per_sec=None,
                    records_per_sec=None,
                    worker_cpu_pct=cpu_pct,
                    worker_memory_mib=memory_mib,
                    worker_throttle_pct=throttle_pct,
                )
                db.add(sample)
                try:
                    await db.commit()
                except Exception as exc:
                    await db.rollback()
                    logger.warning("Failed to save Prometheus sample for run %d t=%d: %s", run_id, t, exc)

    logger.info("Prometheus collection done for run %d (%d samples)", run_id, t // POLL_INTERVAL)
