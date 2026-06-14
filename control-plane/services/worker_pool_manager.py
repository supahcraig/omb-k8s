"""
Worker pool manager — SE-controlled StatefulSet pools for benchmark runs.

Pools are created manually by the SE via the API. The SE specifies which pool
to use when launching a run. Pools stay alive until explicitly deleted from the
Cluster page. There is no auto-provisioning or warm-retention logic.

Pool lifecycle: provisioning → ready → in_use → ready → (deleted by SE)

Public API:
  create_pool(name, replicas, namespace) -> WorkerPool
  claim_pool(pool_id, run_id) -> WorkerPool
  release_pool(pool_id) -> None
  scale_pool(pool_id, replicas, namespace) -> None
  delete_pool(pool_id, namespace) -> None
  build_workers_arg(pool, namespace, port) -> str
"""
import asyncio
import logging
import uuid
from datetime import datetime

from kubernetes import client as k8s_client
from sqlalchemy import select, update

from config import settings as app_settings
from database import AsyncSessionLocal
from models import WorkerPool
from services.k8s_client import load_incluster_once, run_sync

logger = logging.getLogger(__name__)

DEFAULT_POOL_ID = "default"
DEFAULT_STATEFULSET = "omb-worker"
DEFAULT_SERVICE = "omb-worker"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def create_pool(name: str, replicas: int, namespace: str) -> WorkerPool:
    """
    Create a new named worker pool. Inserts a DB row with status='provisioning',
    creates the k8s StatefulSet and headless Service, then returns immediately.
    A background task polls until all replicas are ready and sets status='ready'.
    """
    load_incluster_once()
    apps_api = k8s_client.AppsV1Api()

    pool_id = f"pool-{uuid.uuid4().hex[:8]}"
    sts_name = f"omb-worker-{pool_id}"
    svc_name = f"omb-worker-{pool_id}"

    default_sts = await run_sync(
        apps_api.read_namespaced_stateful_set, DEFAULT_STATEFULSET, namespace
    )

    new_pool = WorkerPool(
        id=pool_id,
        name=name or pool_id,
        statefulset_name=sts_name,
        service_name=svc_name,
        replicas=replicas,
        status="provisioning",
        created_at=datetime.utcnow(),
    )
    async with AsyncSessionLocal() as db:
        db.add(new_pool)
        await db.commit()

    try:
        await _create_statefulset(sts_name, svc_name, replicas, namespace, default_sts)
        await _create_headless_service(svc_name, namespace)
    except Exception as exc:
        async with AsyncSessionLocal() as cleanup_db:
            await cleanup_db.execute(
                update(WorkerPool).where(WorkerPool.id == pool_id).values(status="deleted")
            )
            await cleanup_db.commit()
        raise RuntimeError(f"Failed to create worker pool {pool_id}: {exc}") from exc

    asyncio.create_task(_mark_pool_ready(pool_id, sts_name, namespace, replicas))

    return new_pool


async def claim_pool(pool_id: str, run_id: int) -> WorkerPool:
    """
    Mark a specific pool as in_use for run_id. Raises RuntimeError if the pool
    is not found or not in 'ready' state.
    """
    async with AsyncSessionLocal() as db:
        pool = await db.get(WorkerPool, pool_id)
        if pool is None:
            raise RuntimeError(f"Pool '{pool_id}' not found")
        if pool.status != "ready":
            raise RuntimeError(
                f"Pool '{pool_id}' is currently '{pool.status}' — "
                "only 'ready' pools can be claimed for a run"
            )
        sts_name = pool.statefulset_name
        svc_name = pool.service_name
        replicas = pool.replicas
        name = pool.name
        await db.execute(
            update(WorkerPool)
            .where(WorkerPool.id == pool_id)
            .values(status="in_use", claimed_by_run_id=run_id)
        )
        await db.commit()

    logger.info("Run %d claimed pool %s (%d worker(s))", run_id, pool_id, replicas)
    return WorkerPool(
        id=pool_id,
        name=name,
        statefulset_name=sts_name,
        service_name=svc_name,
        replicas=replicas,
        status="in_use",
        claimed_by_run_id=run_id,
    )


async def release_pool(pool_id: str) -> None:
    """Mark a pool as ready after a run completes. Does not tear it down."""
    async with AsyncSessionLocal() as db:
        await db.execute(
            update(WorkerPool)
            .where(WorkerPool.id == pool_id)
            .values(status="ready", claimed_by_run_id=None)
        )
        await db.commit()
    logger.info("Pool %s released back to ready", pool_id)


async def scale_pool(pool_id: str, replicas: int, namespace: str) -> None:
    """Patch a pool's StatefulSet to a new replica count and update the DB."""
    async with AsyncSessionLocal() as db:
        pool = await db.get(WorkerPool, pool_id)
        if pool is None:
            raise RuntimeError(f"Pool '{pool_id}' not found")
        sts_name = pool.statefulset_name

    load_incluster_once()
    apps_api = k8s_client.AppsV1Api()
    await run_sync(
        apps_api.patch_namespaced_stateful_set,
        sts_name,
        namespace,
        {"spec": {"replicas": replicas}},
    )
    async with AsyncSessionLocal() as db:
        await db.execute(
            update(WorkerPool).where(WorkerPool.id == pool_id).values(replicas=replicas)
        )
        await db.commit()
    logger.info("Pool %s scaled to %d replicas", pool_id, replicas)


async def delete_pool(pool_id: str, namespace: str) -> None:
    """
    Immediately tear down a pool's StatefulSet and Service and mark it deleted.
    No-ops on the default pool (which is never torn down). Safe to call if
    the pool is already deleted.
    """
    if pool_id == DEFAULT_POOL_ID:
        return

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

    logger.info("Pool %s deleted", pool_id)


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


async def _mark_pool_ready(
    pool_id: str, sts_name: str, namespace: str, expected_replicas: int
) -> None:
    """Background task: poll until StatefulSet replicas are Ready, then mark the pool ready."""
    try:
        await _wait_for_pool_ready(sts_name, namespace, expected_replicas)
        async with AsyncSessionLocal() as db:
            await db.execute(
                update(WorkerPool).where(WorkerPool.id == pool_id).values(status="ready")
            )
            await db.commit()
        logger.info("Pool %s is now ready (%d replicas)", pool_id, expected_replicas)
    except Exception as exc:
        logger.warning("Pool %s failed to become ready: %s — marking deleted", pool_id, exc)
        async with AsyncSessionLocal() as db:
            await db.execute(
                update(WorkerPool).where(WorkerPool.id == pool_id).values(status="deleted")
            )
            await db.commit()


async def _create_statefulset(
    sts_name: str,
    svc_name: str,
    replicas: int,
    namespace: str,
    template_sts: k8s_client.V1StatefulSet,
) -> None:
    """Clone the default StatefulSet spec with a new name, replica count, and service selector."""
    spec = template_sts.spec
    new_sts = k8s_client.V1StatefulSet(
        metadata=k8s_client.V1ObjectMeta(
            name=sts_name,
            namespace=namespace,
            labels={"app": sts_name},
        ),
        spec=k8s_client.V1StatefulSetSpec(
            replicas=replicas,
            service_name=svc_name,
            pod_management_policy="Parallel",
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
    """Poll until all StatefulSet replicas report Ready, or raise on timeout."""
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
