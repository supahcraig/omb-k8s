import logging
from pathlib import Path

import yaml
from sqlalchemy import select

from database import AsyncSessionLocal
from models import Workload

logger = logging.getLogger(__name__)

WORKLOADS_DIR = Path("/app/workloads")


async def seed_bundled_workloads() -> None:
    """Seed bundled workloads from /app/workloads/ if none exist in DB."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Workload).where(Workload.is_bundled == True).limit(1)  # noqa: E712
        )
        if result.scalar_one_or_none() is not None:
            logger.info("Bundled workloads already seeded — skipping")
            return

        if not WORKLOADS_DIR.exists():
            logger.warning(
                "Workloads directory %s not found — skipping seed", WORKLOADS_DIR
            )
            return

        yaml_files = sorted(WORKLOADS_DIR.glob("*.yaml"))
        seeded = 0
        for path in yaml_files:
            content = path.read_text()
            description = _extract_description(content)
            workload = Workload(
                name=path.stem,  # filename without extension
                description=description,
                content=content,
                is_bundled=True,
            )
            db.add(workload)
            seeded += 1

        await db.commit()
        logger.info("Seeded %d bundled workloads", seeded)


def _extract_description(content: str) -> str | None:
    """Parse YAML and build a description from key parameters."""
    try:
        data = yaml.safe_load(content)
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict):
        return None
    parts = []
    if data.get("messageSize"):
        size = data["messageSize"]
        label = f"{size // 1024}KB" if size >= 1024 else f"{size}B"
        parts.append(f"{label} messages")
    if data.get("partitionsPerTopic"):
        parts.append(f"{data['partitionsPerTopic']} partitions")
    if data.get("producerRate"):
        parts.append(f"{data['producerRate']:,} msg/s target")
    return ", ".join(parts) if parts else None
