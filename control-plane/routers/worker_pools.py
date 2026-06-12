"""
Worker pools router — list pools and trigger manual release.
"""
import logging

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from database import AsyncSessionLocal
from models import WorkerPool
from services.worker_pool_manager import release_pool_now
from config import settings

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("")
async def list_worker_pools():
    """Return all worker pool rows for the Cluster page."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(WorkerPool)
            .where(WorkerPool.status != "deleted")
            .order_by(WorkerPool.created_at.asc())
        )
        pools = result.scalars().all()
        return [
            {
                "id": p.id,
                "statefulset_name": p.statefulset_name,
                "service_name": p.service_name,
                "replicas": p.replicas,
                "status": p.status,
                "claimed_by_run_id": p.claimed_by_run_id,
                "created_at": p.created_at,
                "released_at": p.released_at,
            }
            for p in pools
        ]


@router.post("/{pool_id}/release", status_code=204)
async def release_pool(pool_id: str):
    """
    Immediately tear down a concurrent pool's StatefulSet and Service.

    Returns 409 if the pool is currently in_use (run is active).
    Returns 404 if pool_id is not found.
    Returns 204 (no content) on success.
    """
    async with AsyncSessionLocal() as db:
        pool = await db.get(WorkerPool, pool_id)
        if pool is None:
            raise HTTPException(status_code=404, detail=f"Pool '{pool_id}' not found")
        if pool.status == "in_use":
            raise HTTPException(
                status_code=409,
                detail=f"Pool '{pool_id}' is currently in use by run {pool.claimed_by_run_id} — wait for the run to complete",
            )
        if pool.status == "deleted":
            return  # idempotent — already gone

    await release_pool_now(pool_id, settings.omb_namespace)
