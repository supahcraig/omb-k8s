"""Settings router — GET/PUT /api/settings and POST /api/settings/test-connection."""
import json
import logging
import re as _re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Setting
from schemas import ClusterConfig, PrometheusConfig, SettingsOut

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CLUSTER_KEY = "cluster"
PROMETHEUS_KEY = "prometheus"

_CLUSTER_PASSWORD_FIELDS = ("sasl_password",)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _merge_cluster(incoming: dict, stored: Optional[dict]) -> dict:
    """Preserve existing password fields when the incoming value is None."""
    out = dict(incoming)
    if stored is not None:
        for field in _CLUSTER_PASSWORD_FIELDS:
            if out.get(field) is None:
                out[field] = stored.get(field)
    return out


async def _load_setting(db: AsyncSession, key: str) -> Optional[dict]:
    """Load a setting from the DB and parse the JSON value.  Returns None if
    the key does not exist."""
    row: Optional[Setting] = await db.get(Setting, key)
    if row is None:
        return None
    return json.loads(row.value)


async def _store_setting(db: AsyncSession, key: str, data: dict) -> None:
    """Stage a setting upsert. Caller is responsible for commit/rollback."""
    setting = Setting(key=key, value=json.dumps(data))
    await db.merge(setting)


def _build_cluster_out(stored: Optional[dict]) -> Optional[ClusterConfig]:
    if stored is None:
        return None
    return ClusterConfig(**stored)


def _extract_scrape_password(scrape_yaml_str: str) -> tuple:
    """Extract basic_auth password from a scrape YAML string.

    Returns (redacted_yaml, plaintext_password).
    If no password found, returns (original_yaml, None).
    """
    pattern = r'(password:\s*)([^\n]+)'
    match = _re.search(pattern, scrape_yaml_str)
    if not match:
        return scrape_yaml_str, None
    plaintext = match.group(2).strip()
    redacted = _re.sub(pattern, r'\g<1>__REDACTED__', scrape_yaml_str, count=1)
    return redacted, plaintext


def _inject_scrape_password(scrape_yaml_str: str, password: str) -> str:
    """Replace __REDACTED__ sentinel with the actual password."""
    return scrape_yaml_str.replace('__REDACTED__', password, 1)


def _build_prometheus_out(stored: Optional[dict]) -> Optional[PrometheusConfig]:
    """Build a PrometheusConfig for the API response.

    BYOC: re-injects the stored password into the scrape YAML so the
    frontend can display the full (unredacted) YAML for editing.
    Self-hosted: normalises scrape_targets from the stored comma-separated string.
    """
    if stored is None:
        return None
    d = dict(stored)

    if d.get('mode') == 'byoc':
        raw_yaml = d.get('scrape_yaml') or ''
        password = d.get('scrape_yaml_password')
        if password and '__REDACTED__' in raw_yaml:
            d['scrape_yaml'] = _inject_scrape_password(raw_yaml, password)
        d['scrape_targets'] = None
    else:
        scrape_str = d.pop('scrape_targets_str', None)
        if 'scrape_targets' not in d or d.get('scrape_targets') is None:
            if scrape_str:
                d['scrape_targets'] = [t.strip() for t in scrape_str.split(',') if t.strip()]
            else:
                d['scrape_targets'] = None
        d['scrape_yaml'] = None
        d['scrape_yaml_password'] = None

    return PrometheusConfig(**{k: v for k, v in d.items() if k in PrometheusConfig.model_fields})


def _prometheus_to_storage(config: PrometheusConfig, existing_stored: Optional[dict]) -> dict:
    """Convert a PrometheusConfig to the dict persisted in the DB.

    BYOC: stores scrape_yaml (redacted) + scrape_yaml_password (plaintext).
    Self-hosted: stores scrape_targets_str (comma-separated string).
    """
    d = config.model_dump()

    if config.mode == 'byoc':
        raw_yaml = d.get('scrape_yaml') or ''
        # If the client sent back a YAML that still contains __REDACTED__, the
        # password was not changed — preserve the existing value.
        if '__REDACTED__' in raw_yaml:
            d['scrape_yaml'] = raw_yaml
            d['scrape_yaml_password'] = (existing_stored or {}).get('scrape_yaml_password')
        else:
            redacted_yaml, plaintext = _extract_scrape_password(raw_yaml)
            d['scrape_yaml'] = redacted_yaml
            d['scrape_yaml_password'] = plaintext
        d.pop('scrape_targets', None)
        d['scrape_targets_str'] = ''
    else:
        targets: Optional[list] = d.pop('scrape_targets', None)
        d['scrape_targets_str'] = ','.join(targets) if targets else ''
        d['scrape_yaml'] = None
        d['scrape_yaml_password'] = None

    return d


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=SettingsOut)
async def get_settings(db: AsyncSession = Depends(get_db)) -> SettingsOut:
    cluster_stored = await _load_setting(db, CLUSTER_KEY)
    prometheus_stored = await _load_setting(db, PROMETHEUS_KEY)

    return SettingsOut(
        cluster=_build_cluster_out(cluster_stored),
        prometheus=_build_prometheus_out(prometheus_stored),
    )


@router.put("", response_model=SettingsOut)
async def update_settings(
    body: SettingsOut,
    db: AsyncSession = Depends(get_db),
) -> SettingsOut:
    """Persist cluster and Prometheus configuration.

    Password fields: if the incoming value is non-None, store it.
    If None, preserve the existing stored value unchanged.
    """
    cluster_stored = await _load_setting(db, CLUSTER_KEY)
    prometheus_stored = await _load_setting(db, PROMETHEUS_KEY)

    try:
        if body.cluster is not None:
            cluster_dict = body.cluster.model_dump()
            cluster_to_save = _merge_cluster(cluster_dict, cluster_stored)
            await _store_setting(db, CLUSTER_KEY, cluster_to_save)

        if body.prometheus is not None:
            prometheus_to_save = _prometheus_to_storage(body.prometheus, prometheus_stored)
            await _store_setting(db, PROMETHEUS_KEY, prometheus_to_save)

        await db.commit()
    except Exception:
        await db.rollback()
        raise

    # Re-read from DB to build the canonical response.
    cluster_stored = await _load_setting(db, CLUSTER_KEY)
    prometheus_stored = await _load_setting(db, PROMETHEUS_KEY)

    return SettingsOut(
        cluster=_build_cluster_out(cluster_stored),
        prometheus=_build_prometheus_out(prometheus_stored),
    )


@router.post("/test-connection")
async def test_connection(db: AsyncSession = Depends(get_db)) -> dict:
    """Test connectivity to the configured Kafka/Redpanda broker.

    Attempts to create and immediately stop an AIOKafkaProducer with the
    current cluster settings.  Returns ``{"success": bool, "message": str}``.
    """
    try:
        from aiokafka import AIOKafkaProducer  # noqa: PLC0415
        from aiokafka.errors import KafkaConnectionError  # noqa: PLC0415
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="aiokafka is not installed — cannot test broker connectivity.",
        )

    cluster_stored = await _load_setting(db, CLUSTER_KEY)
    if cluster_stored is None:
        return {"success": False, "message": "No cluster configuration found. Save settings first."}

    bootstrap = cluster_stored.get("bootstrap_servers", "").strip()
    if not bootstrap:
        return {"success": False, "message": "bootstrap_servers is not configured."}

    tls_enabled: bool = cluster_stored.get("tls_enabled", False)
    sasl_enabled: bool = cluster_stored.get("sasl_enabled", False)
    sasl_mechanism: Optional[str] = cluster_stored.get("sasl_mechanism")
    sasl_username: Optional[str] = cluster_stored.get("sasl_username")
    sasl_password: Optional[str] = cluster_stored.get("sasl_password")

    # Build aiokafka producer kwargs.
    producer_kwargs: dict = {
        "bootstrap_servers": bootstrap,
    }

    if tls_enabled:
        import ssl  # noqa: PLC0415
        ssl_ctx = ssl.create_default_context()
        producer_kwargs["ssl_context"] = ssl_ctx
        producer_kwargs["security_protocol"] = "SASL_SSL" if sasl_enabled else "SSL"
    elif sasl_enabled:
        producer_kwargs["security_protocol"] = "SASL_PLAINTEXT"

    if sasl_enabled and sasl_mechanism and sasl_username and sasl_password:
        # aiokafka accepts "SCRAM-SHA-256", "SCRAM-SHA-512", "PLAIN" directly.
        producer_kwargs["sasl_mechanism"] = sasl_mechanism
        producer_kwargs["sasl_plain_username"] = sasl_username
        producer_kwargs["sasl_plain_password"] = sasl_password

    import asyncio  # noqa: PLC0415

    producer = AIOKafkaProducer(**producer_kwargs)
    started = False
    stopped = False
    try:
        await asyncio.wait_for(producer.start(), timeout=10.0)
        started = True
        await producer.stop()
        stopped = True
        return {
            "success": True,
            "message": f"Successfully connected to broker at {bootstrap}.",
        }
    except asyncio.TimeoutError:
        logger.warning("test-connection timed out for %s", bootstrap)
        return {
            "success": False,
            "message": (
                f"Connection to {bootstrap} timed out after 10 s. "
                "Check the broker address and that it is reachable from this cluster."
            ),
        }
    except KafkaConnectionError:
        logger.warning("test-connection KafkaConnectionError for %s", bootstrap)
        return {
            "success": False,
            "message": (
                f"Could not reach broker at {bootstrap}. "
                "Check the bootstrap address and network connectivity."
            ),
        }
    except Exception:
        logger.exception("test-connection unexpected error for %s", bootstrap)
        return {
            "success": False,
            "message": (
                f"Failed to connect to {bootstrap}. "
                "Check broker address, TLS settings, and SASL credentials."
            ),
        }
    finally:
        try:
            await producer.stop()
        except Exception:
            pass
