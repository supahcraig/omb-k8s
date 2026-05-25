"""
Kubernetes client initialisation — in-cluster only.

Returns a tuple of (CoreV1Api, BatchV1Api, AppsV1Api) configured via the
pod's mounted service account token.  Never falls back to a local kubeconfig.
"""
from kubernetes import client, config as k8s_config


def get_k8s_clients() -> tuple:
    """Load in-cluster config and return (CoreV1Api, BatchV1Api, AppsV1Api)."""
    k8s_config.load_incluster_config()
    return (
        client.CoreV1Api(),
        client.BatchV1Api(),
        client.AppsV1Api(),
    )
