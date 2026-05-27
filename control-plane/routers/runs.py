"""
Runs router — create, list, retrieve, and cancel benchmark runs.
"""
import asyncio
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from config import settings
from database import AsyncSessionLocal, get_db
from models import Metrics, Run
from schemas import RunListItem, RunOut, RunStatus
from services.omb_runner import runner
from services.prometheus_collector import collect_prometheus
from services.result_parser import parse_result_from_logs

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Request body
# ---------------------------------------------------------------------------


class RunCreate(BaseModel):
    name: Optional[str] = None
    driver_content: str
    workload_content: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=list[RunListItem])
async def list_runs(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Run)
        .options(selectinload(Run.metrics))
        .order_by(Run.started_at.desc())
    )
    runs = result.scalars().all()

    items = []
    for run in runs:
        m = run.metrics
        items.append(
            RunListItem(
                id=run.id,
                name=run.name,
                status=run.status,
                started_at=run.started_at,
                completed_at=run.completed_at,
                publish_rate_avg=m.publish_rate_avg if m else None,
                publish_latency_avg=m.publish_latency_avg if m else None,
                publish_latency_p99=m.publish_latency_p99 if m else None,
                end_to_end_latency_avg=m.end_to_end_latency_avg if m else None,
                end_to_end_latency_p99=m.end_to_end_latency_p99 if m else None,
                consume_rate_avg=m.consume_rate_avg if m else None,
            )
        )
    return items


@router.post("", response_model=RunOut, status_code=201)
async def create_run(
    body: RunCreate,
    db: AsyncSession = Depends(get_db),
):
    run = Run(
        name=body.name,
        status="running",
        driver_config=body.driver_content,
        workload_config=body.workload_content,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)

    # Start the k8s Job — if this fails, mark the run failed immediately
    try:
        await runner.start(run.id, body.driver_content, body.workload_content)
    except Exception as exc:
        logger.error("Failed to start k8s Job for run %d: %s", run.id, exc)
        async with AsyncSessionLocal() as fail_db:
            fail_run = await fail_db.get(Run, run.id)
            if fail_run:
                fail_run.status = RunStatus.failed.value
                fail_run.completed_at = datetime.utcnow()
                await fail_db.commit()
        raise HTTPException(
            status_code=503,
            detail=f"Failed to start benchmark job: {exc}",
        )

    # Both tasks are long-running coroutines that must run concurrently —
    # BackgroundTasks awaits sequentially so we use asyncio.create_task() instead.
    prom_url = f"http://omb-kube-prometheus-stack-prometheus.{settings.omb_namespace}.svc.cluster.local:9090"
    asyncio.create_task(_finish_run(run.id))
    asyncio.create_task(collect_prometheus(run.id, settings.omb_namespace, prom_url))

    # Re-query with selectinload so Pydantic can access the metrics relationship
    # without hitting the lazy-load greenlet restriction.
    result = await db.execute(
        select(Run).options(selectinload(Run.metrics)).where(Run.id == run.id)
    )
    run = result.scalar_one()
    return RunOut.model_validate(run)


@router.get("/{run_id}", response_model=RunOut)
async def get_run(run_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Run)
        .options(selectinload(Run.metrics))
        .where(Run.id == run_id)
    )
    run = result.scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return RunOut.model_validate(run)


@router.delete("/{run_id}", status_code=204)
async def delete_run(run_id: int, db: AsyncSession = Depends(get_db)):
    run = await db.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")

    await runner.stop(run_id)
    run.status = RunStatus.cancelled.value
    run.completed_at = datetime.utcnow()
    await db.commit()


# ---------------------------------------------------------------------------
# Background task
# ---------------------------------------------------------------------------


async def _finish_run(run_id: int) -> None:
    """
    Poll until the k8s Job finishes, then parse results and update the DB.
    Times out after 4 hours (7200 × 2 s).
    """
    for _ in range(7200):
        await asyncio.sleep(2)
        if runner.is_done(run_id):
            break

    # If the job didn't finish naturally (4-hour timeout), stop it to avoid
    # leaving a hung k8s Job running indefinitely.
    if not runner.is_done(run_id):
        logger.warning("_finish_run: run %d timed out — stopping k8s Job", run_id)
        try:
            await runner.stop(run_id)
        except Exception as exc:
            logger.error("_finish_run: could not stop run %d: %s", run_id, exc)

    async with AsyncSessionLocal() as db:
        run = await db.get(Run, run_id)
        if run is None:
            logger.warning("_finish_run: run %d not found in DB", run_id)
            return

        lines = runner.get_lines(run_id)
        success = runner.succeeded(run_id)

        metrics_data = parse_result_from_logs(lines)

        # Mark completed if we parsed metrics, regardless of Job exit code.
        # The aggregate summary line only appears on clean OMB completion, so
        # its presence is a reliable signal that results are valid.
        if metrics_data:
            run.status = RunStatus.completed.value
            metrics = Metrics(run_id=run_id, **metrics_data)
            db.add(metrics)
        else:
            run.status = RunStatus.failed.value
            logger.warning(
                "_finish_run: run %d — no parseable metrics (success=%s, lines=%d)",
                run_id, success, len(lines),
            )

        run.completed_at = datetime.utcnow()

        try:
            await db.commit()
        except Exception:
            await db.rollback()
            logger.exception("_finish_run: DB commit failed for run %d", run_id)
            return

    logger.info(
        "_finish_run: run %d finished — status=%s", run_id, run.status
    )
