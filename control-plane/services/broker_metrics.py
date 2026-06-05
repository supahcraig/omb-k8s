"""
Broker-side Redpanda Prometheus metric collection.

Scrapes four throughput counters directly from the broker's /metrics endpoint
at run start and run end, then computes average rates over the run duration.
"""
import json
import logging
from datetime import datetime
from typing import Optional

import httpx
import yaml as _yaml
from sqlalchemy import select

from database import AsyncSessionLocal
from models import Setting

logger = logging.getLogger(__name__)

_TRACKED = {
    "redpanda_kafka_records_produced_total",
    "redpanda_kafka_records_fetched_total",
    "redpanda_rpc_received_bytes",
    "redpanda_rpc_sent_bytes",
}

# {run_id: {"ts": datetime, "values": {metric_name: float}}}
_baseline: dict[int, dict] = {}


async def _load_broker_config() -> dict:
    """
    Return {"urls": [...], "auth": (user, pass) | None} from settings.

    Self-hosted: plain http to scrape_targets on port 9644, path /metrics.
    BYOC: parses scrape_yaml for scheme, metrics_path, targets, and basic_auth.
    """
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Setting).where(Setting.key == "prometheus"))
        row = result.scalars().first()
        if not row:
            return {"urls": [], "auth": None}
        stored = json.loads(row.value or "{}")

        # Self-hosted: comma-separated host:port strings
        scrape_str = stored.get("scrape_targets_str") or ""
        if scrape_str:
            urls = [f"http://{t.strip()}/metrics" for t in scrape_str.split(",") if t.strip()]
            return {"urls": urls, "auth": None}

        # BYOC: parse the full scrape job YAML
        scrape_yaml_str = stored.get("scrape_yaml") or ""
        if scrape_yaml_str:
            try:
                jobs = _yaml.safe_load(scrape_yaml_str)
                if not isinstance(jobs, list) or not jobs:
                    return {"urls": [], "auth": None}
                job = jobs[0]
                scheme       = job.get("scheme", "http")
                metrics_path = job.get("metrics_path", "/metrics")
                targets = []
                for sc in job.get("static_configs", []):
                    targets.extend(sc.get("targets", []))
                urls = [f"{scheme}://{t}{metrics_path}" for t in targets]
                ba = job.get("basic_auth", {})
                username = ba.get("username")
                password = stored.get("scrape_yaml_password") or ba.get("password")
                auth = (username, password) if username and password else None
                return {"urls": urls, "auth": auth}
            except Exception as exc:
                logger.warning("Failed to parse scrape_yaml: %s", exc)
                return {"urls": [], "auth": None}

        return {"urls": [], "auth": None}


def _parse_metrics(text: str) -> dict[str, float]:
    """Sum all samples for tracked metrics from Prometheus text exposition format."""
    totals: dict[str, float] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        metric_name = parts[0].split("{")[0]
        if metric_name not in _TRACKED:
            continue
        try:
            totals[metric_name] = totals.get(metric_name, 0.0) + float(parts[1])
        except ValueError:
            continue
    return totals


async def _scrape(urls: list, auth: Optional[tuple]) -> Optional[dict[str, float]]:
    """Scrape all broker URLs and return summed counter values, or None on failure."""
    combined: dict[str, float] = {}
    try:
        async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
            for url in urls:
                try:
                    resp = await client.get(url, auth=auth)
                    if resp.status_code == 200:
                        for k, v in _parse_metrics(resp.text).items():
                            combined[k] = combined.get(k, 0.0) + v
                    else:
                        logger.debug("Broker %s returned HTTP %d", url, resp.status_code)
                except Exception as exc:
                    logger.debug("Broker scrape %s failed: %s", url, exc)
    except Exception as exc:
        logger.debug("Broker metrics scrape failed: %s", exc)
        return None
    return combined or None


async def snapshot_baseline(run_id: int) -> None:
    """Scrape broker metrics at run start and cache as baseline."""
    cfg = await _load_broker_config()
    if not cfg["urls"]:
        return
    values = await _scrape(cfg["urls"], cfg["auth"])
    if values is not None:
        _baseline[run_id] = {"ts": datetime.utcnow(), "values": values}
        logger.info("Broker baseline for run %d: %s", run_id, values)


async def collect_broker_rates(run_id: int, started_at: datetime) -> Optional[dict]:
    """
    Scrape broker metrics at run end and compute average rates since baseline.
    Returns dict with broker_* rate keys ready to merge into Metrics, or None.
    """
    baseline = _baseline.pop(run_id, None)
    cfg = await _load_broker_config()
    if not cfg["urls"]:
        return None

    end_values = await _scrape(cfg["urls"], cfg["auth"])
    if not end_values:
        return None

    start_values = baseline["values"] if baseline else {}
    start_ts = baseline["ts"] if baseline else started_at
    duration = (datetime.utcnow() - start_ts).total_seconds()
    if duration < 1:
        return None

    def rate(metric: str) -> Optional[float]:
        end = end_values.get(metric)
        if end is None:
            return None
        delta = max(0.0, end - start_values.get(metric, 0.0))
        return delta / duration

    produced = rate("redpanda_kafka_records_produced_total")
    fetched  = rate("redpanda_kafka_records_fetched_total")
    rpc_rx   = rate("redpanda_rpc_received_bytes")
    rpc_tx   = rate("redpanda_rpc_sent_bytes")

    if all(v is None for v in [produced, fetched, rpc_rx, rpc_tx]):
        return None

    return {
        "broker_publish_rate_msg": produced,
        "broker_consume_rate_msg": fetched,
        "broker_publish_rate_mb": rpc_rx / 1_048_576 if rpc_rx is not None else None,
        "broker_consume_rate_mb": rpc_tx / 1_048_576 if rpc_tx is not None else None,
    }
