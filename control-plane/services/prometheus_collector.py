"""
Background Prometheus collector — polls worker resource metrics every 15 s
during a benchmark run and writes them to prometheus_samples.

Queries the in-cluster Prometheus (kube-prometheus-stack) for cAdvisor
metrics on omb-worker-* pods. Silently no-ops if Prometheus is unreachable
so a missing Prometheus deployment never breaks a benchmark run.
"""
import asyncio
import json
import logging
import math
from typing import Optional

import httpx

from database import AsyncSessionLocal
from models import PrometheusSample
from services.omb_runner import runner

logger = logging.getLogger(__name__)

POLL_INTERVAL = 15  # seconds between samples


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


async def _query_per_pod(client: httpx.AsyncClient, base_url: str, query: str) -> dict:
    """Execute a PromQL query and return a dict of {pod_name: float_value}.

    Returns an empty dict on any error or non-200 response.
    """
    try:
        resp = await client.get(f"{base_url}/api/v1/query", params={"query": query}, timeout=8.0)
        if resp.status_code != 200:
            return {}
        results = resp.json().get("data", {}).get("result", [])
        out = {}
        for item in results:
            pod = item.get("metric", {}).get("pod", "unknown")
            try:
                val = float(item["value"][1])
                if not (math.isnan(val) or math.isinf(val)):
                    out[pod] = val
            except (KeyError, ValueError, IndexError):
                pass
        return out
    except Exception as exc:
        logger.debug("Prometheus per-pod query error: %s", exc)
        return {}


async def _collect_sample(
    client: httpx.AsyncClient,
    prom_url: str,
    namespace: str,
    run_id: int,
    t: int,
    cpu_request_cores: float,
    statefulset_name: str = "omb-worker",
) -> None:
    """Query Prometheus and write one PrometheusSample row."""
    pod_regex = f"{statefulset_name}-[0-9]+"
    worker_selector = f'namespace="{namespace}",pod=~"{pod_regex}",container="worker"'

    cpu_pct = await _query(client, prom_url,
        f'100 * avg(rate(container_cpu_usage_seconds_total{{{worker_selector}}}[2m]))'
        f' / {cpu_request_cores}')

    memory_mib = await _query(client, prom_url,
        f'avg(container_memory_working_set_bytes{{{worker_selector}}}) / 1048576')

    throttle_pct = await _query(client, prom_url,
        f'100 * max('
        f'  rate(container_cpu_cfs_throttled_periods_total{{{worker_selector}}}[2m])'
        f'  / rate(container_cpu_cfs_periods_total{{{worker_selector}}}[2m])'
        f')')

    memory_per_pod = await _query_per_pod(client, prom_url,
        f'container_memory_working_set_bytes{{{worker_selector}}} / 1048576')

    cpu_per_pod = await _query_per_pod(client, prom_url,
        f'100 * rate(container_cpu_usage_seconds_total{{{worker_selector}}}[2m])'
        f' / {cpu_request_cores}')

    # container_network_* metrics are pod-level (no container label) — use a
    # separate selector that omits container="worker" from worker_selector.
    net_selector = f'namespace="{namespace}",pod=~"{pod_regex}"'

    net_tx_per_pod = await _query_per_pod(client, prom_url,
        f'sum by (pod) ('
        f'  rate(container_network_transmit_bytes_total{{{net_selector},interface!="lo"}}[2m])'
        f')')

    net_drop_per_pod = await _query_per_pod(client, prom_url,
        f'sum by (pod) ('
        f'  rate(container_network_transmit_packets_dropped_total{{{net_selector},interface!="lo"}}[2m])'
        f'  +'
        f'  rate(container_network_receive_packets_dropped_total{{{net_selector},interface!="lo"}}[2m])'
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
            worker_memory_per_pod=json.dumps(memory_per_pod) if memory_per_pod else None,
            worker_cpu_per_pod=json.dumps(cpu_per_pod) if cpu_per_pod else None,
            worker_net_tx_per_pod=json.dumps(net_tx_per_pod) if net_tx_per_pod else None,
            worker_net_drop_per_pod=json.dumps(net_drop_per_pod) if net_drop_per_pod else None,
        )
        db.add(sample)
        try:
            await db.commit()
        except Exception as exc:
            await db.rollback()
            logger.warning("Failed to save Prometheus sample for run %d t=%d: %s", run_id, t, exc)


async def probe_broker_prometheus(targets: list) -> None:
    """GET /metrics from each broker target and log a sample of metric names.

    Runs once at job start — no storage, diagnostic only.
    Targets are host:port strings (e.g. 'broker-1:9644').
    """
    async with httpx.AsyncClient(timeout=5.0) as client:
        for target in targets:
            url = f"http://{target}/metrics"
            try:
                resp = await client.get(url)
                if resp.status_code == 200:
                    lines = [l for l in resp.text.splitlines() if l and not l.startswith('#')]
                    names = sorted({l.split('{')[0].split(' ')[0] for l in lines[:200]})[:20]
                    logger.info("Broker Prometheus %s: %d bytes, sample metrics: %s", target, len(resp.text), names)
                else:
                    logger.warning("Broker Prometheus %s returned HTTP %d", target, resp.status_code)
            except Exception as exc:
                logger.warning("Broker Prometheus %s unreachable: %s", target, exc)


async def collect_prometheus(
    run_id: int,
    namespace: str,
    prom_url: str,
    cpu_request_cores: float = 4.0,
    statefulset_name: str = None,
) -> None:
    """
    Poll Prometheus every POLL_INTERVAL seconds until the run finishes.
    Takes an immediate sample on start, then continues at POLL_INTERVAL cadence.
    Writes one PrometheusSample row per interval.
    statefulset_name scopes queries to only this run's worker pods.
    """
    if not prom_url:
        logger.debug("No Prometheus URL configured — skipping collection for run %d", run_id)
        return

    sts = statefulset_name or "omb-worker"
    logger.info("Starting Prometheus collection for run %d → %s (pool: %s)", run_id, prom_url, sts)
    t = 0

    async with httpx.AsyncClient() as client:
        await _collect_sample(client, prom_url, namespace, run_id, t, cpu_request_cores, sts)

        while not runner.is_done(run_id):
            await asyncio.sleep(POLL_INTERVAL)
            t += POLL_INTERVAL

            if runner.is_done(run_id):
                break

            await _collect_sample(client, prom_url, namespace, run_id, t, cpu_request_cores, sts)

    logger.info("Prometheus collection done for run %d (%d samples)", run_id, t // POLL_INTERVAL)
