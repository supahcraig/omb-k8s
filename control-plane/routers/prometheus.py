"""
Prometheus router — connectivity test and sample retrieval.
"""
import logging

import httpx
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import PrometheusSample

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/test")
async def test_prometheus(
    url: str = Query(..., description="Prometheus base URL"),
    username: str = Query("", description="Basic auth username (optional)"),
    password: str = Query("", description="Basic auth password (optional)"),
):
    """
    Test Prometheus connectivity by calling /api/v1/status/buildinfo.

    Returns {"success": bool, "message": str}.
    """
    endpoint = url.rstrip("/") + "/api/v1/status/buildinfo"
    auth = (username, password) if username else None

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(endpoint, auth=auth)
        if response.status_code == 200:
            return {"success": True, "message": "Prometheus reachable"}
        return {
            "success": False,
            "message": f"Prometheus returned HTTP {response.status_code}",
        }
    except httpx.ConnectError as exc:
        return {"success": False, "message": f"Connection refused: {exc}"}
    except httpx.TimeoutException:
        return {"success": False, "message": "Connection timed out"}
    except Exception as exc:
        logger.warning("Prometheus test error: %s", exc)
        return {"success": False, "message": str(exc)}


@router.get("/runs/{run_id}")
async def get_prometheus_samples(
    run_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Return all PrometheusSample rows for the given run."""
    result = await db.execute(
        select(PrometheusSample)
        .where(PrometheusSample.run_id == run_id)
        .order_by(PrometheusSample.t.asc())
    )
    samples = result.scalars().all()
    return [
        {
            "id": s.id,
            "run_id": s.run_id,
            "t": s.t,
            "bytes_in_per_sec": s.bytes_in_per_sec,
            "bytes_out_per_sec": s.bytes_out_per_sec,
            "records_per_sec": s.records_per_sec,
            "worker_cpu_pct": s.worker_cpu_pct,
            "worker_memory_mib": s.worker_memory_mib,
            "worker_throttle_pct": s.worker_throttle_pct,
        }
        for s in samples
    ]
