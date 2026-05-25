"""Settings router — GET/PUT /api/settings and POST /api/settings/test-connection."""
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Setting
from schemas import ClusterConfig, PrometheusConfig, SettingsOut
from services.encryption import decrypt, encrypt

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CLUSTER_KEY = "cluster"
PROMETHEUS_KEY = "prometheus"

# Cluster fields that hold sensitive secrets and must be encrypted at rest.
_CLUSTER_PASSWORD_FIELDS = {"sasl_password"}
# Prometheus fields that hold sensitive secrets.
_PROMETHEUS_PASSWORD_FIELDS = {"remote_write_password"}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _encrypt_passwords(data: dict, password_fields: set) -> dict:
    """Return a copy of *data* with password_fields values encrypted."""
    out = dict(data)
    for field in password_fields:
        val = out.get(field)
        if val is not None:
            out[field] = encrypt(val)
    return out


def _redact_passwords(data: dict, password_fields: set) -> dict:
    """Return a copy of *data* with password_fields set to None."""
    out = dict(data)
    for field in password_fields:
        out[field] = None
    return out


def _merge_passwords(
    incoming: dict,
    stored: Optional[dict],
    password_fields: set,
) -> dict:
    """Return *incoming* with password fields filled from *stored* when the
    incoming value is None (caller did not supply a new password).

    The returned dict has passwords in *encrypted* form — callers must not
    pass plaintext-encrypted hybrids here; *stored* must already be the
    encrypted version from the DB.
    """
    out = dict(incoming)
    for field in password_fields:
        incoming_val = out.get(field)
        if incoming_val is None and stored is not None:
            # Keep the existing encrypted value.
            out[field] = stored.get(field)
        elif incoming_val is not None:
            # New plaintext supplied — encrypt it.
            out[field] = encrypt(incoming_val)
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
    """Build a ClusterConfig with passwords redacted, or None if no stored config."""
    if stored is None:
        return None
    redacted = _redact_passwords(stored, _CLUSTER_PASSWORD_FIELDS)
    return ClusterConfig(**redacted)


def _build_prometheus_out(stored: Optional[dict]) -> Optional[PrometheusConfig]:
    """Build a PrometheusConfig with passwords redacted, or None if no stored config.

    Handles the scrape_targets storage representation: stored as a
    comma-separated string under the key ``scrape_targets_str`` to avoid
    JSON-in-JSON nesting issues; the Pydantic schema exposes ``scrape_targets``
    as ``Optional[List[str]]``.
    """
    if stored is None:
        return None
    d = dict(stored)
    # Normalise scrape_targets from storage representation.
    scrape_str = d.pop("scrape_targets_str", None)
    if "scrape_targets" not in d or d.get("scrape_targets") is None:
        if scrape_str:
            d["scrape_targets"] = [t.strip() for t in scrape_str.split(",") if t.strip()]
        else:
            d["scrape_targets"] = None
    d = _redact_passwords(d, _PROMETHEUS_PASSWORD_FIELDS)
    return PrometheusConfig(**d)


def _prometheus_to_storage(config: PrometheusConfig) -> dict:
    """Convert a PrometheusConfig to the dict we persist in the DB.

    scrape_targets (list) → scrape_targets_str (comma-separated string).
    The password field is left in its raw form so the caller can decide
    whether to encrypt / preserve the existing value.
    """
    d = config.model_dump()
    targets: Optional[list] = d.pop("scrape_targets", None)
    d["scrape_targets_str"] = ",".join(targets) if targets else ""
    return d


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=SettingsOut)
async def get_settings(db: AsyncSession = Depends(get_db)) -> SettingsOut:
    """Return current settings with all password fields redacted."""
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

    Password fields: if the incoming value is non-None, encrypt and store it.
    If None, preserve the existing stored password unchanged.
    """
    cluster_stored = await _load_setting(db, CLUSTER_KEY)
    prometheus_stored = await _load_setting(db, PROMETHEUS_KEY)

    try:
        if body.cluster is not None:
            cluster_dict = body.cluster.model_dump()
            cluster_to_save = _merge_passwords(
                cluster_dict, cluster_stored, _CLUSTER_PASSWORD_FIELDS
            )
            await _store_setting(db, CLUSTER_KEY, cluster_to_save)

        if body.prometheus is not None:
            prometheus_dict = _prometheus_to_storage(body.prometheus)
            prometheus_to_save = _merge_passwords(
                prometheus_dict, prometheus_stored, _PROMETHEUS_PASSWORD_FIELDS
            )
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
    sasl_password_enc: Optional[str] = cluster_stored.get("sasl_password")

    # Decrypt the stored password for the connection attempt.
    sasl_password: Optional[str] = None
    if sasl_password_enc:
        try:
            sasl_password = decrypt(sasl_password_enc)
        except Exception:
            return {
                "success": False,
                "message": "Failed to decrypt stored SASL password — re-save credentials.",
            }

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

    producer = AIOKafkaProducer(**producer_kwargs)
    started = False
    stopped = False
    try:
        await producer.start()
        started = True
        await producer.stop()
        stopped = True
        return {
            "success": True,
            "message": f"Successfully connected to broker at {bootstrap}.",
        }
    except KafkaConnectionError:
        logger.warning("test-connection KafkaConnectionError for %s", bootstrap)
        return {
            "success": False,
            "message": (
                f"Could not reach broker at {bootstrap}. "
                "Check that VPC peering is active and the bootstrap address is correct."
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
        if started and not stopped:
            try:
                await producer.stop()
            except Exception:
                pass
