"""
Worker pool manager — dynamic StatefulSet allocation for concurrent runs.

Each concurrent benchmark run gets its own dedicated worker pool (StatefulSet +
headless Service). The default pool ("omb-worker") is used when no other run is
active and is never torn down.

After a run completes, the pool's StatefulSet stays alive for a configurable
retention period so nodes remain warm for the next concurrent run. If a new run
claims the pool before the timer fires, the teardown is cancelled.

Public API:
  claim_pool(run_id, namespace, db) -> WorkerPool
  schedule_teardown(pool_id, namespace, retention_minutes)
  cancel_teardown(pool_id)
  release_pool_now(pool_id, namespace, db)
  build_workers_arg(pool, namespace, port) -> str
"""
import asyncio
import logging
import uuid
from datetime import datetime
from typing import Optional

from kubernetes import client as k8s_client
from sqlalchemy import select, update

from config import settings as app_settings
from database import AsyncSessionLocal
from models import Run, WorkerPool
from services.k8s_client import load_incluster_once, run_sync

logger = logging.getLogger(__name__)

# Module-level registry: pool_id → pending asyncio.Task for delayed teardown.
_teardown_tasks: dict[str, asyncio.Task] = {}

DEFAULT_POOL_ID = "default"
DEFAULT_STATEFULSET = "omb-worker"
DEFAULT_SERVICE = "omb-worker"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def claim_pool(run_id: int, namespace: str) -> WorkerPool:
    """
    Claim a worker pool for run_id.

    If no other run is currently active, claims the default pool.
    If any run is active, creates a new concurrent pool matching the default
    StatefulSet's replica count.

    Manages its own DB sessions so callers (OmbRunner.start) don't need one.
    """
    load_incluster_once()
    apps_api = k8s_client.AppsV1Api()

    # Always read the live replica count from the default StatefulSet.
    default_sts = await run_sync(
        apps_api.read_namespaced_stateful_set, DEFAULT_STATEFULSET, namespace
    )
    replica_count: int = default_sts.spec.replicas or 1

    async with AsyncSessionLocal() as db:
        async with db.begin():
            # Check for any currently running run (excluding this one).
            result = await db.execute(
                select(Run).where(Run.status == "running", Run.id != run_id)
            )
            active_runs = result.scalars().all()

            if not active_runs:
                # No concurrent activity — claim the default pool.
                cancel_teardown(DEFAULT_POOL_ID)
                await db.execute(
                    update(WorkerPool)
                    .where(WorkerPool.id == DEFAULT_POOL_ID)
                    .values(status="in_use", claimed_by_run_id=run_id, released_at=None)
                )
                logger.info("Run %d claimed default pool (%d workers)", run_id, replica_count)
                return WorkerPool(
                    id=DEFAULT_POOL_ID,
                    statefulset_name=DEFAULT_STATEFULSET,
                    service_name=DEFAULT_SERVICE,
                    replicas=replica_count,
                    status="in_use",
                    claimed_by_run_id=run_id,
                )

            # Concurrent run(s) active — check for a warm ready pool before creating one.
            result = await db.execute(
                select(WorkerPool).where(
                    WorkerPool.status == "ready",
                    WorkerPool.id != DEFAULT_POOL_ID,
                ).limit(1)
            )
            warm_pool = result.scalar_one_or_none()
            if warm_pool is not None:
                cancel_teardown(warm_pool.id)
                await db.execute(
                    update(WorkerPool)
                    .where(WorkerPool.id == warm_pool.id)
                    .values(status="in_use", claimed_by_run_id=run_id, released_at=None, replicas=replica_count)
                )
                logger.info("Run %d claimed warm pool %s (%d workers)", run_id, warm_pool.id, replica_count)
                return WorkerPool(
                    id=warm_pool.id,
                    statefulset_name=warm_pool.statefulset_name,
                    service_name=warm_pool.service_name,
                    replicas=replica_count,
                    status="in_use",
                    claimed_by_run_id=run_id,
                )

            # No warm pool available — create a new one.
            pool_id = f"pool-{uuid.uuid4().hex[:8]}"
            sts_name = f"omb-worker-{pool_id}"
            svc_name = f"omb-worker-{pool_id}"

            new_pool = WorkerPool(
                id=pool_id,
                statefulset_name=sts_name,
                service_name=svc_name,
                replicas=replica_count,
                status="provisioning",
                claimed_by_run_id=run_id,
                created_at=datetime.utcnow(),
            )
            db.add(new_pool)

    # Create StatefulSet and Service outside the transaction (k8s calls are slow).
    try:
        await _create_statefulset(sts_name, svc_name, replica_count, namespace, default_sts)
        await _create_headless_service(svc_name, namespace)
    except Exception as exc:
        async with AsyncSessionLocal() as cleanup_db:
            await cleanup_db.execute(
                update(WorkerPool).where(WorkerPool.id == pool_id).values(status="deleted")
            )
            await cleanup_db.commit()
        raise RuntimeError(f"Failed to provision worker pool {pool_id}: {exc}") from exc

    await _wait_for_pool_ready(sts_name, namespace, replica_count)

    async with AsyncSessionLocal() as db:
        await db.execute(
            update(WorkerPool).where(WorkerPool.id == pool_id).values(status="in_use")
        )
        await db.commit()

    logger.info("Run %d claimed new pool %s (%d workers)", run_id, pool_id, replica_count)
    return WorkerPool(
        id=pool_id,
        statefulset_name=sts_name,
        service_name=svc_name,
        replicas=replica_count,
        status="in_use",
        claimed_by_run_id=run_id,
    )


def schedule_teardown(pool_id: str, namespace: str, retention_minutes: int) -> None:
    """
    Schedule delayed teardown of a concurrent pool after retention_minutes.

    retention_minutes=0 means Manual only — no teardown scheduled.
    The default pool is never torn down by this function.
    """
    if pool_id == DEFAULT_POOL_ID:
        return
    if retention_minutes <= 0:
        logger.info("Pool %s set to manual-only retention; no teardown scheduled", pool_id)
        return

    cancel_teardown(pool_id)  # cancel any prior pending task for this pool

    async def _delayed_teardown() -> None:
        try:
            await asyncio.sleep(retention_minutes * 60)
            logger.info("Retention expired for pool %s — tearing down", pool_id)
            await release_pool_now(pool_id, namespace)
        except asyncio.CancelledError:
            logger.debug("Teardown task cancelled for pool %s", pool_id)
        finally:
            _teardown_tasks.pop(pool_id, None)

    task = asyncio.create_task(_delayed_teardown())
    _teardown_tasks[pool_id] = task
    logger.info("Teardown scheduled for pool %s in %d min", pool_id, retention_minutes)


def cancel_teardown(pool_id: str) -> None:
    """Cancel a pending teardown task for pool_id, if one exists."""
    task = _teardown_tasks.pop(pool_id, None)
    if task and not task.done():
        task.cancel()
        logger.debug("Cancelled pending teardown for pool %s", pool_id)


async def release_pool_now(pool_id: str, namespace: str) -> None:
    """
    Immediately tear down a concurrent pool's StatefulSet and Service.

    No-ops on the default pool. Safe to call if the pool is already deleted.
    Manages its own DB sessions internally.
    """
    if pool_id == DEFAULT_POOL_ID:
        async with AsyncSessionLocal() as db:
            await db.execute(
                update(WorkerPool)
                .where(WorkerPool.id == DEFAULT_POOL_ID)
                .values(status="ready", claimed_by_run_id=None)
            )
            await db.commit()
        return

    cancel_teardown(pool_id)

    async with AsyncSessionLocal() as db:
        pool = await db.get(WorkerPool, pool_id)
        if pool is None or pool.status == "deleted":
            return
        sts_name = pool.statefulset_name
        svc_name = pool.service_name
        await db.execute(
            update(WorkerPool).where(WorkerPool.id == pool_id).values(status="tearing_down")
        )
        await db.commit()

    load_incluster_once()
    apps_api = k8s_client.AppsV1Api()
    core_api = k8s_client.CoreV1Api()

    for delete_call, kind, name in (
        (apps_api.delete_namespaced_stateful_set, "StatefulSet", sts_name),
        (core_api.delete_namespaced_service, "Service", svc_name),
    ):
        try:
            await run_sync(delete_call, name, namespace)
            logger.info("Deleted %s %s for pool %s", kind, name, pool_id)
        except k8s_client.ApiException as exc:
            if exc.status != 404:
                logger.warning("Error deleting %s %s: %s", kind, name, exc)

    async with AsyncSessionLocal() as db:
        await db.execute(
            update(WorkerPool)
            .where(WorkerPool.id == pool_id)
            .values(status="deleted", released_at=datetime.utcnow(), claimed_by_run_id=None)
        )
        await db.commit()

    logger.info("Pool %s fully released", pool_id)


async def recover_pool_teardowns(namespace: str) -> None:
    """
    On startup, reschedule or immediately execute teardowns for warm pools whose
    asyncio tasks were killed by a pod restart.

    - ready pool with warm_until in the past  → release immediately
    - ready pool with warm_until in the future → schedule for remaining seconds
    - ready pool with no warm_until           → leave alone (manual-only retention)
    """
    now = datetime.utcnow()
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(WorkerPool).where(
                WorkerPool.status == "ready",
                WorkerPool.id != DEFAULT_POOL_ID,
                WorkerPool.warm_until.is_not(None),
            )
        )
        pools = result.scalars().all()

    for pool in pools:
        remaining = (pool.warm_until - now).total_seconds()
        if remaining <= 0:
            logger.info(
                "Startup recovery: pool %s warm_until expired %.0fs ago — releasing now",
                pool.id, -remaining,
            )
            asyncio.create_task(release_pool_now(pool.id, namespace))
        else:
            remaining_minutes = remaining / 60
            logger.info(
                "Startup recovery: rescheduling teardown for pool %s in %.1f min",
                pool.id, remaining_minutes,
            )
            schedule_teardown(pool.id, namespace, int(remaining_minutes) or 1)


def build_workers_arg(pool: WorkerPool, namespace: str, port: int) -> str:
    """Construct the --workers argument for the OMB driver Job."""
    return ",".join(
        f"http://{pool.statefulset_name}-{i}.{pool.service_name}"
        f".{namespace}.svc.cluster.local:{port}"
        for i in range(pool.replicas)
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


async def _create_statefulset(
    sts_name: str,
    svc_name: str,
    replicas: int,
    namespace: str,
    template_sts: k8s_client.V1StatefulSet,
) -> None:
    """Clone the default StatefulSet spec with a new name and service selector."""
    spec = template_sts.spec

    # Build a fresh StatefulSet using the template's pod spec verbatim,
    # only overriding name, serviceName, selector, and pod labels.
    new_sts = k8s_client.V1StatefulSet(
        metadata=k8s_client.V1ObjectMeta(
            name=sts_name,
            namespace=namespace,
            labels={"app": sts_name},
        ),
        spec=k8s_client.V1StatefulSetSpec(
            replicas=replicas,
            service_name=svc_name,
            selector=k8s_client.V1LabelSelector(match_labels={"app": sts_name}),
            template=k8s_client.V1PodTemplateSpec(
                metadata=k8s_client.V1ObjectMeta(labels={"app": sts_name}),
                spec=spec.template.spec,
            ),
        ),
    )

    apps_api = k8s_client.AppsV1Api()
    await run_sync(apps_api.create_namespaced_stateful_set, namespace, new_sts)
    logger.info("Created StatefulSet %s with %d replica(s)", sts_name, replicas)


async def _create_headless_service(svc_name: str, namespace: str) -> None:
    """Create a headless Service for the new StatefulSet."""
    svc = k8s_client.V1Service(
        metadata=k8s_client.V1ObjectMeta(
            name=svc_name,
            namespace=namespace,
            labels={"app": svc_name},
        ),
        spec=k8s_client.V1ServiceSpec(
            cluster_ip="None",
            selector={"app": svc_name},
            ports=[
                k8s_client.V1ServicePort(
                    port=app_settings.omb_worker_port,
                    target_port=app_settings.omb_worker_port,
                    protocol="TCP",
                )
            ],
        ),
    )
    core_api = k8s_client.CoreV1Api()
    await run_sync(core_api.create_namespaced_service, namespace, svc)
    logger.info("Created headless Service %s", svc_name)


async def _wait_for_pool_ready(
    sts_name: str, namespace: str, expected_replicas: int, timeout_seconds: int = 600
) -> None:
    """Poll until all StatefulSet replicas report Ready, or timeout."""
    apps_api = k8s_client.AppsV1Api()
    for _ in range(timeout_seconds // 5):
        await asyncio.sleep(5)
        try:
            sts = await run_sync(
                apps_api.read_namespaced_stateful_set, sts_name, namespace
            )
            ready = sts.status.ready_replicas or 0
            if ready >= expected_replicas:
                logger.info("Pool %s ready (%d/%d replicas)", sts_name, ready, expected_replicas)
                return
            logger.debug("Waiting for pool %s: %d/%d ready", sts_name, ready, expected_replicas)
        except Exception as exc:
            logger.warning("Error checking StatefulSet %s: %s", sts_name, exc)

    raise RuntimeError(
        f"Timed out waiting for StatefulSet {sts_name} to become ready "
        f"after {timeout_seconds}s"
    )
