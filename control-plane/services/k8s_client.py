"""
Kubernetes client initialisation — in-cluster only.

Provides:
  - load_incluster_once()  — idempotent config loader
  - run_sync()             — run a blocking k8s call in a thread-pool executor
  - get_k8s_clients()      — convenience factory: (CoreV1Api, BatchV1Api, AppsV1Api)
"""
import asyncio
import functools
import logging

from kubernetes import client, config as k8s_config

logger = logging.getLogger(__name__)

_config_loaded = False


def load_incluster_once() -> None:
    """Load in-cluster service-account credentials (idempotent)."""
    global _config_loaded
    if not _config_loaded:
        k8s_config.load_incluster_config()
        _config_loaded = True


async def run_sync(func, *args, **kwargs):
    """Run a synchronous callable in the default thread-pool executor."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, functools.partial(func, *args, **kwargs))


def get_k8s_clients() -> tuple:
    """Return (CoreV1Api, BatchV1Api, AppsV1Api) using in-cluster config."""
    load_incluster_once()
    return (
        client.CoreV1Api(),
        client.BatchV1Api(),
        client.AppsV1Api(),
    )
