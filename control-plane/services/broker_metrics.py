"""
Broker-side Redpanda Prometheus metric collection.

Scrapes four throughput counters directly from the broker's /metrics endpoint
at run start and run end, then computes average rates over the run duration.
"""
import json
import logging
import re
from datetime import datetime
from typing import Optional

import httpx
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
    """Return {"targets": [...], "auth": (user, pass) | None} from settings."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Setting).where(Setting.key == "prometheus"))
        row = result.scalars().first()
        if not row:
            return {"targets": [], "auth": None}
        stored = json.loads(row.value or "{}")

        scrape_str = stored.get("scrape_targets_str") or ""
        if scrape_str:
            return {
                "targets": [t.strip() for t in scrape_str.split(",") if t.strip()],
                "auth": None,
            }

        scrape_yaml = stored.get("scrape_yaml") or ""
        if scrape_yaml:
            targets = re.findall(r"['\"]([^'\"]+:\d+)['\"]", scrape_yaml)
            u_match = re.search(r"username:\s*['\"]?([^\s'\"]+)['\"]?", scrape_yaml)
            username = u_match.group(1) if u_match else None
            password = stored.get("scrape_yaml_password")
            auth = (username, password) if username and password else None
            return {"targets": targets, "auth": auth}

        return {"targets": [], "auth": None}


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


async def _scrape(targets: list, auth: Optional[tuple]) -> Optional[dict[str, float]]:
    """Scrape all broker targets and return summed counter values, or None on failure."""
    combined: dict[str, float] = {}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            for target in targets:
                url = f"http://{target}/metrics"
                resp = await client.get(url, auth=auth)
                if resp.status_code == 200:
                    for k, v in _parse_metrics(resp.text).items():
                        combined[k] = combined.get(k, 0.0) + v
                else:
                    logger.debug("Broker %s returned HTTP %d", target, resp.status_code)
    except Exception as exc:
        logger.debug("Broker metrics scrape failed: %s", exc)
        return None
    return combined or None


async def snapshot_baseline(run_id: int) -> None:
    """Scrape broker metrics at run start and cache as baseline."""
    cfg = await _load_broker_config()
    if not cfg["targets"]:
        return
    values = await _scrape(cfg["targets"], cfg["auth"])
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
    if not cfg["targets"]:
        return None

    end_values = await _scrape(cfg["targets"], cfg["auth"])
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
