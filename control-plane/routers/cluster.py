"""
Cluster router — list pods and fetch logs from the omb namespace.
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Query
from kubernetes import client as k8s_client

from config import settings
from services.k8s_client import load_incluster_once, run_sync

logger = logging.getLogger(__name__)
router = APIRouter()


def _age(ts) -> str:
    if ts is None:
        return "—"
    now = datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    s = int((now - ts).total_seconds())
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m"
    if s < 86400:
        return f"{s // 3600}h"
    return f"{s // 86400}d"


async def _probe_worker(pod_name: str, namespace: str) -> bool:
    """Return True if the worker HTTP server responds."""
    url = f"http://{pod_name}.omb-worker.{namespace}.svc.cluster.local:{settings.omb_worker_port}/"
    def _sync_get() -> int:
        with httpx.Client(timeout=1.5) as client:
            return client.get(url).status_code
    try:
        return await asyncio.to_thread(_sync_get) < 500
    except Exception:
        return False


@router.get("/pods")
async def list_pods():
    load_incluster_once()
    core_api = k8s_client.CoreV1Api()
    try:
        pod_list = await run_sync(core_api.list_namespaced_pod, settings.omb_namespace)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    import re
    worker_re = re.compile(r"^omb-worker-\d+$")

    pods = []
    probe_targets = []  # (index into pods, pod_name) for workers

    for pod in pod_list.items:
        cst = pod.status.container_statuses or []
        total = len(pod.spec.containers)
        ready = sum(1 for c in cst if c.ready)
        restarts = sum(c.restart_count for c in cst)
        containers = [c.name for c in pod.spec.containers]
        is_worker = bool(worker_re.match(pod.metadata.name))

        pods.append({
            "name": pod.metadata.name,
            "phase": pod.status.phase or "Unknown",
            "ready": f"{ready}/{total}",
            "restarts": restarts,
            "age": _age(pod.metadata.creation_timestamp),
            "node": (pod.spec.node_name or "—").split(".")[0],
            "containers": containers,
            "worker_healthy": None,  # populated below for workers
        })

        if is_worker and (pod.status.phase or "") == "Running":
            probe_targets.append((len(pods) - 1, pod.metadata.name))

    # Probe all running workers concurrently
    if probe_targets:
        results = await asyncio.gather(
            *[_probe_worker(name, settings.omb_namespace) for _, name in probe_targets]
        )
        for (idx, _), healthy in zip(probe_targets, results):
            pods[idx]["worker_healthy"] = healthy

    pods.sort(key=lambda p: p["name"])
    return {"namespace": settings.omb_namespace, "pods": pods}


@router.delete("/pods/{pod_name}", status_code=204)
async def restart_pod(pod_name: str):
    """Delete a pod so its controller (StatefulSet/Deployment) recreates it."""
    load_incluster_once()
    core_api = k8s_client.CoreV1Api()
    try:
        await run_sync(core_api.delete_namespaced_pod, pod_name, settings.omb_namespace)
    except k8s_client.ApiException as exc:
        if exc.status == 404:
            raise HTTPException(status_code=404, detail=f"Pod {pod_name!r} not found")
        raise HTTPException(status_code=500, detail=exc.reason or str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/pods/{pod_name}/logs")
async def get_pod_logs(
    pod_name: str,
    container: Optional[str] = Query(None),
    tail: int = Query(500, ge=1, le=5000),
):
    load_incluster_once()
    core_api = k8s_client.CoreV1Api()
    kwargs: dict = {"tail_lines": tail}
    if container:
        kwargs["container"] = container
    try:
        raw = await run_sync(
            core_api.read_namespaced_pod_log,
            pod_name,
            settings.omb_namespace,
            **kwargs,
        )
    except k8s_client.ApiException as exc:
        if exc.status == 404:
            raise HTTPException(status_code=404, detail=f"Pod {pod_name!r} not found")
        raise HTTPException(status_code=500, detail=exc.reason or str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    lines = [ln for ln in (raw or "").split("\n") if ln]
    return {"pod": pod_name, "container": container, "lines": lines}
