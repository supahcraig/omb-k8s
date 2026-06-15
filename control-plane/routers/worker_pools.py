"""
Worker pools router — SE-controlled worker pool management.
"""
import logging

from fastapi import APIRouter, HTTPException
from kubernetes import client as k8s_client
from pydantic import BaseModel
from sqlalchemy import select

from config import settings
from database import AsyncSessionLocal
from models import WorkerPool
from services.k8s_client import load_incluster_once, run_sync
from services.worker_pool_manager import create_pool, delete_pool, scale_pool

logger = logging.getLogger(__name__)

router = APIRouter()


class PoolCreate(BaseModel):
    name: str
    replicas: int


class PoolScale(BaseModel):
    replicas: int


def _pool_row(p: WorkerPool, live_replicas: int | None = None) -> dict:
    return {
        "id": p.id,
        "name": p.name or p.id,
        "statefulset_name": p.statefulset_name,
        "service_name": p.service_name,
        "replicas": live_replicas if live_replicas is not None else p.replicas,
        "status": p.status,
        "claimed_by_run_id": p.claimed_by_run_id,
        "created_at": p.created_at,
        "released_at": p.released_at,
    }


async def _live_replicas(sts_name: str, namespace: str) -> int | None:
    """Query the StatefulSet's current spec.replicas from k8s. Returns None on error."""
    try:
        load_incluster_once()
        apps_api = k8s_client.AppsV1Api()
        sts = await run_sync(apps_api.read_namespaced_stateful_set, sts_name, namespace, _request_timeout=(5.0, 15.0))
        return sts.spec.replicas or 0
    except Exception as exc:
        logger.debug("Could not read StatefulSet %s: %s", sts_name, exc)
        return None


@router.get("")
async def list_worker_pools():
    """Return all non-deleted worker pool rows for the Cluster page."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(WorkerPool)
            .where(WorkerPool.status != "deleted")
            .order_by(WorkerPool.created_at.asc())
        )
        pools = result.scalars().all()

    # For the default pool the DB replicas column is always 0 (it's managed by
    # Helm/kubectl, not our API), so query k8s for the live count.
    rows = []
    for p in pools:
        live = None
        if p.id == "default":
            live = await _live_replicas(p.statefulset_name, settings.omb_namespace)
        rows.append(_pool_row(p, live))
    return rows


@router.post("", status_code=201)
async def create_worker_pool(body: PoolCreate):
    """
    Create a new named worker pool by cloning the default StatefulSet spec.
    Returns immediately with status='provisioning'; background task waits for
    all replicas to become ready and transitions to 'ready'.
    """
    if body.replicas < 1 or body.replicas > 20:
        raise HTTPException(status_code=400, detail="replicas must be between 1 and 20")

    pool = await create_pool(body.name, body.replicas, settings.omb_namespace)
    return _pool_row(pool)


@router.patch("/{pool_id}/scale", status_code=200)
async def scale_worker_pool(pool_id: str, body: PoolScale):
    """Scale a pool's StatefulSet to a new replica count."""
    if body.replicas < 1 or body.replicas > 20:
        raise HTTPException(status_code=400, detail="replicas must be between 1 and 20")

    async with AsyncSessionLocal() as db:
        pool = await db.get(WorkerPool, pool_id)
        if pool is None:
            raise HTTPException(status_code=404, detail=f"Pool '{pool_id}' not found")
        if pool.status == "in_use":
            raise HTTPException(
                status_code=409,
                detail=f"Pool '{pool_id}' is in use by run {pool.claimed_by_run_id} — wait for it to complete",
            )

    await scale_pool(pool_id, body.replicas, settings.omb_namespace)

    async with AsyncSessionLocal() as db:
        pool = await db.get(WorkerPool, pool_id)
        return _pool_row(pool)


@router.post("/{pool_id}/release", status_code=204)
async def release_pool_endpoint(pool_id: str):
    """
    Immediately tear down a pool's StatefulSet and Service.

    Returns 409 if the pool is currently in_use.
    Returns 404 if pool_id is not found.
    Returns 204 on success.
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
            return  # idempotent

    await delete_pool(pool_id, settings.omb_namespace)
