import logging
from pathlib import Path

import yaml
from sqlalchemy import select

from database import AsyncSessionLocal
from models import Driver, Workload

logger = logging.getLogger(__name__)

WORKLOADS_DIR = Path("/app/workloads")
DRIVERS_DIR   = Path("/app/drivers")


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
            try:
                content = path.read_text()
            except OSError as exc:
                logger.warning("Could not read workload file %s — skipping: %s", path, exc)
                continue
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


async def seed_bundled_drivers() -> None:
    """Seed bundled driver configs from /app/drivers/ if none exist in DB."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Driver).where(Driver.is_bundled == True).limit(1)  # noqa: E712
        )
        if result.scalar_one_or_none() is not None:
            logger.info("Bundled drivers already seeded — skipping")
            return

        if not DRIVERS_DIR.exists():
            logger.warning("Drivers directory %s not found — skipping seed", DRIVERS_DIR)
            return

        yaml_files = sorted(DRIVERS_DIR.glob("*.yaml"))
        seeded = 0
        for path in yaml_files:
            try:
                content = path.read_text()
            except OSError as exc:
                logger.warning("Could not read driver file %s — skipping: %s", path, exc)
                continue
            display_name = path.stem.replace("-", " ").title()
            description = _extract_driver_description(content)
            driver = Driver(
                name=display_name,
                description=description,
                content=content,
                is_bundled=True,
            )
            db.add(driver)
            seeded += 1

        await db.commit()
        logger.info("Seeded %d bundled drivers", seeded)


def _extract_description(content: str) -> str | None:
    """Parse YAML and build a description from key workload parameters."""
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


def _extract_driver_description(content: str) -> str | None:
    """Parse driver YAML and build a description from producer/topic config."""
    parts: list[str] = []
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("acks="):
            parts.append(f"acks={line.split('=', 1)[1]}")
        elif line.startswith("compression.type="):
            val = line.split("=", 1)[1]
            if val != "none":
                parts.append(f"{val} compression")
        elif line.startswith("batch.size="):
            val = int(line.split("=", 1)[1])
            label = f"{val // 1024}KB batch" if val >= 1024 else f"{val}B batch"
            parts.append(label)
        elif line.startswith("min.insync.replicas="):
            parts.append(f"min.isr={line.split('=', 1)[1]}")
    return ", ".join(parts) if parts else None
