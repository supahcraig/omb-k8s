"""
Worker status and scaling router — /api/workers

GET  /api/workers/status   — query omb-worker StatefulSet replica status
POST /api/workers/scale    — patch spec.replicas on the StatefulSet
"""
import logging

from fastapi import APIRouter, HTTPException

from config import settings
from schemas import WorkerPod, WorkerStatus
from services.omb_runner import _load_config, _run_sync

logger = logging.getLogger(__name__)

router = APIRouter()

_STATEFULSET_NAME = "omb-worker"
_MAX_REPLICAS = 20
_MIN_REPLICAS = 1


@router.get("/status", response_model=WorkerStatus)
async def get_worker_status() -> WorkerStatus:
    """
    Query the omb-worker StatefulSet and return replica status plus
    per-pod phase information.
    """
    from kubernetes import client as k8s_client

    _load_config()
    apps_api = k8s_client.AppsV1Api()
    core_api = k8s_client.CoreV1Api()
    namespace = settings.omb_namespace

    # Fetch StatefulSet
    try:
        sts = await _run_sync(
            apps_api.read_namespaced_stateful_set,
            _STATEFULSET_NAME,
            namespace,
        )
    except k8s_client.ApiException as exc:
        logger.error("Could not read StatefulSet %s: %s", _STATEFULSET_NAME, exc)
        raise HTTPException(
            status_code=503,
            detail=f"Could not reach k8s API: {exc.reason}",
        )

    desired: int = sts.spec.replicas or 0
    ready: int = sts.status.ready_replicas or 0

    # Fetch pods for omb-worker
    try:
        pod_list = await _run_sync(
            core_api.list_namespaced_pod,
            namespace,
            label_selector="app=omb-worker",
        )
        pods = [
            WorkerPod(
                name=p.metadata.name,
                status=p.status.phase or "Unknown",
            )
            for p in pod_list.items
        ]
    except k8s_client.ApiException as exc:
        logger.warning("Could not list worker pods: %s", exc)
        pods = []

    return WorkerStatus(desired=desired, ready=ready, pods=pods)


@router.post("/scale")
async def scale_workers(body: dict) -> dict:
    """
    Scale the omb-worker StatefulSet.

    Request body: ``{"replicas": int}``
    Response:     ``{"desired": int}``

    Replicas must be between 1 and 20 (inclusive).
    """
    from kubernetes import client as k8s_client

    replicas = body.get("replicas")
    if replicas is None:
        raise HTTPException(status_code=422, detail="'replicas' field is required.")
    if not isinstance(replicas, int):
        raise HTTPException(status_code=422, detail="'replicas' must be an integer.")
    if replicas < _MIN_REPLICAS or replicas > _MAX_REPLICAS:
        raise HTTPException(
            status_code=422,
            detail=f"'replicas' must be between {_MIN_REPLICAS} and {_MAX_REPLICAS}.",
        )

    _load_config()
    apps_api = k8s_client.AppsV1Api()
    namespace = settings.omb_namespace

    patch_body = {"spec": {"replicas": replicas}}
    try:
        await _run_sync(
            apps_api.patch_namespaced_stateful_set,
            _STATEFULSET_NAME,
            namespace,
            patch_body,
        )
        logger.info("Scaled %s to %d replicas", _STATEFULSET_NAME, replicas)
    except k8s_client.ApiException as exc:
        logger.error("Failed to scale StatefulSet: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=f"Could not scale StatefulSet: {exc.reason}",
        )

    return {"desired": replicas}
