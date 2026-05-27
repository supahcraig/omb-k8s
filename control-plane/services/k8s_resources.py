import logging

logger = logging.getLogger(__name__)

_FALLBACK_CPU_CORES = 4.0
_FALLBACK_MEM_MIB = 8192


def parse_cpu(value: str) -> float:
    """Parse a Kubernetes CPU quantity string to float cores.

    Examples: "15" -> 15.0, "500m" -> 0.5
    """
    if value.endswith("m"):
        return int(value[:-1]) / 1000.0
    return float(value)


def parse_memory_mib(value: str) -> int:
    """Parse a Kubernetes memory quantity string to integer MiB.

    Examples: "60Gi" -> 61440, "512Mi" -> 512
    """
    if value.endswith("Gi"):
        return int(value[:-2]) * 1024
    if value.endswith("Mi"):
        return int(value[:-2])
    if value.endswith("Ki"):
        return max(1, int(value[:-2]) // 1024)
    # Plain bytes
    return max(1, int(value) // (1024 * 1024))


async def read_worker_resources(namespace: str) -> tuple[float, int]:
    """Read worker CPU request (cores) and memory limit (MiB) from the StatefulSet.

    Returns fallback values (4.0 cores, 8192 MiB) if the k8s API is unreachable.
    """
    from kubernetes import client as k8s_client
    from services.k8s_client import load_incluster_once, run_sync

    load_incluster_once()
    apps_api = k8s_client.AppsV1Api()
    try:
        sts = await run_sync(
            apps_api.read_namespaced_stateful_set, "omb-worker", namespace
        )
        container = next(
            (c for c in sts.spec.template.spec.containers if c.name == "worker"),
            None,
        )
        if container and container.resources:
            requests = container.resources.requests or {}
            limits = container.resources.limits or {}
            cpu_str = requests.get("cpu", str(_FALLBACK_CPU_CORES))
            mem_str = limits.get("memory", f"{_FALLBACK_MEM_MIB}Mi")
            return parse_cpu(cpu_str), parse_memory_mib(mem_str)
    except Exception as exc:
        logger.warning("Could not read worker resources from StatefulSet: %s", exc)
    return _FALLBACK_CPU_CORES, _FALLBACK_MEM_MIB
