"""Grafana service URL discovery."""
import logging
from typing import Optional

from fastapi import APIRouter

from config import settings
from services.k8s_client import get_k8s_clients, run_sync

logger = logging.getLogger(__name__)

router = APIRouter()

_GRAFANA_SERVICE = "omb-grafana"


def _get_grafana_url(svc) -> Optional[str]:
    """Extract the external URL from a k8s Service object. Returns None if unavailable."""
    if svc.spec.type != "LoadBalancer":
        return None
    ingress = svc.status.load_balancer.ingress
    if not ingress:
        return None
    entry = ingress[0]
    host = entry.hostname or entry.ip
    if not host:
        return None
    return f"http://{host}"


@router.get("/url")
async def get_grafana_url() -> dict:
    """Return the Grafana LoadBalancer URL, or null if unavailable."""
    try:
        core_api, _, _ = get_k8s_clients()
        svc = await run_sync(
            core_api.read_namespaced_service,
            _GRAFANA_SERVICE,
            settings.omb_namespace,
        )
        url = _get_grafana_url(svc)
        return {"url": url}
    except Exception:
        logger.debug("Could not read Grafana service URL", exc_info=True)
        return {"url": None}
