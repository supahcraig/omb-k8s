"""
Worker status and scaling router — /api/workers

GET  /api/workers/status   — query omb-worker StatefulSet replica status
POST /api/workers/scale    — patch spec.replicas on the StatefulSet
"""
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from config import settings
from schemas import WorkerPod, WorkerStatus
from services.k8s_client import load_incluster_once, run_sync

logger = logging.getLogger(__name__)

router = APIRouter()

_STATEFULSET_NAME = "omb-worker"
_MIN_REPLICAS = 1
_MAX_REPLICAS = 20


class ScaleRequest(BaseModel):
    replicas: int = Field(..., ge=_MIN_REPLICAS, le=_MAX_REPLICAS)


@router.get("/status", response_model=WorkerStatus)
async def get_worker_status() -> WorkerStatus:
    """
    Query the omb-worker StatefulSet and return replica status plus
    per-pod phase information.
    """
    from kubernetes import client as k8s_client

    load_incluster_once()
    apps_api = k8s_client.AppsV1Api()
    core_api = k8s_client.CoreV1Api()
    namespace = settings.omb_namespace

    try:
        sts = await run_sync(
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

    try:
        pod_list = await run_sync(
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
async def scale_workers(body: ScaleRequest) -> dict:
    """
    Scale the omb-worker StatefulSet.

    Request body: ``{"replicas": int}``  (1–20 inclusive)
    Response:     ``{"desired": int}``
    """
    from kubernetes import client as k8s_client

    load_incluster_once()
    apps_api = k8s_client.AppsV1Api()
    namespace = settings.omb_namespace

    patch_body = {"spec": {"replicas": body.replicas}}
    try:
        await run_sync(
            apps_api.patch_namespaced_stateful_set,
            _STATEFULSET_NAME,
            namespace,
            patch_body,
        )
        logger.info("Scaled %s to %d replicas", _STATEFULSET_NAME, body.replicas)
    except k8s_client.ApiException as exc:
        logger.error("Failed to scale StatefulSet: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=f"Could not scale StatefulSet: {exc.reason}",
        )

    return {"desired": body.replicas}
