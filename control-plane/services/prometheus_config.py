"""
Apply Prometheus scrape config on startup.

Writes stored scrape targets from the DB to the
omb-prometheus-additional-scrape-configs Secret so the Prometheus Operator
picks up the configuration after a control plane pod restart.

Remote write config (BYOC mode) cannot be applied dynamically without
patching the Prometheus CR — log a warning and rely on Helm values for that.
"""
import json
import logging

import yaml
from kubernetes import client as k8s_client

from config import settings
from database import AsyncSessionLocal
from models import Setting
from services.k8s_client import load_incluster_once, run_sync

logger = logging.getLogger(__name__)

_SECRET_NAME = "omb-prometheus-additional-scrape-configs"
_SECRET_KEY = "additional-scrape-configs.yaml"


async def apply_prometheus_config_on_startup() -> None:
    """
    Re-apply stored Prometheus scrape targets to the additionalScrapeConfigs
    Secret on every startup so the Prometheus Operator stays in sync after
    a control plane pod restart.

    Failures are non-fatal — the app starts regardless.
    """
    async with AsyncSessionLocal() as db:
        row = await db.get(Setting, "prometheus")
        if row is None:
            logger.info("No Prometheus config stored — skipping scrape config apply")
            return
        stored = json.loads(row.value)

    scrape_targets_str = stored.get("scrape_targets_str", "")
    scrape_targets = [t.strip() for t in scrape_targets_str.split(",") if t.strip()]

    if not scrape_targets:
        logger.info("No Prometheus scrape targets configured — skipping apply")
        return

    scrape_configs = [
        {
            "job_name": "omb-cluster",
            "static_configs": [{"targets": scrape_targets}],
        }
    ]
    scrape_yaml = yaml.dump(scrape_configs, default_flow_style=False)

    try:
        load_incluster_once()
        core_api = k8s_client.CoreV1Api()
        namespace = settings.omb_namespace

        secret = k8s_client.V1Secret(
            metadata=k8s_client.V1ObjectMeta(name=_SECRET_NAME, namespace=namespace),
            string_data={_SECRET_KEY: scrape_yaml},
        )

        try:
            await run_sync(
                core_api.replace_namespaced_secret, _SECRET_NAME, namespace, secret
            )
            logger.info("Updated Prometheus scrape config Secret %s", _SECRET_NAME)
        except k8s_client.ApiException as exc:
            if exc.status == 404:
                await run_sync(core_api.create_namespaced_secret, namespace, secret)
                logger.info("Created Prometheus scrape config Secret %s", _SECRET_NAME)
            else:
                raise

        remote_write_url = stored.get("remote_write_url")
        if remote_write_url:
            logger.warning(
                "remote_write_url is configured but dynamic remote write requires "
                "patching the Prometheus CR — set kube-prometheus-stack.prometheus."
                "prometheusSpec.remoteWrite in your Helm values file instead."
            )

    except Exception as exc:
        logger.error(
            "Failed to apply Prometheus scrape config on startup (non-fatal): %s", exc
        )
