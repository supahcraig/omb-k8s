"""
Sweeps router — multi-run benchmarks that iterate over parameter combinations.
"""
import asyncio
import itertools
import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

import yaml
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from database import AsyncSessionLocal, get_db
from models import Run, Sweep
from routers.runs import _finish_run
from schemas import RunOut, RunStatus, SweepCreate, SweepOut
from services.omb_runner import runner

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=list[SweepOut])
async def list_sweeps(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Sweep).order_by(Sweep.started_at.desc())
    )
    sweeps = result.scalars().all()
    return [SweepOut.model_validate(s) for s in sweeps]


@router.post("", response_model=SweepOut, status_code=201)
async def create_sweep(
    body: SweepCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    sweep = Sweep(
        name=body.name,
        status="running",
        parameter_axes=json.dumps(body.parameter_axes),
        cooldown_seconds=body.cooldown_seconds,
    )
    db.add(sweep)
    await db.commit()
    await db.refresh(sweep)

    # Build all parameter combinations
    param_names = list(body.parameter_axes.keys())
    param_values = [body.parameter_axes[k] for k in param_names]
    combinations = list(itertools.product(*param_values))

    # Pre-create all Run records so they're visible immediately
    run_ids: list[int] = []
    for combo in combinations:
        params = dict(zip(param_names, combo))
        workload_content = _apply_params(body.workload_content, params)
        run = Run(
            name=f"{body.name} — {_combo_label(params)}",
            status="pending",
            driver_config=body.driver_base_content,
            workload_config=workload_content,
            sweep_id=sweep.id,
            sweep_params=json.dumps(params),
        )
        db.add(run)
        await db.flush()   # populate run.id before commit
        run_ids.append(run.id)

    await db.commit()

    # Execute runs sequentially in background
    background_tasks.add_task(
        _execute_sweep,
        sweep.id,
        run_ids,
        body.driver_base_content,
        body.workload_content,
        param_names,
        combinations,
        body.cooldown_seconds,
    )

    return SweepOut.model_validate(sweep)


@router.get("/{sweep_id}", response_model=SweepOut)
async def get_sweep(sweep_id: int, db: AsyncSession = Depends(get_db)):
    sweep = await db.get(Sweep, sweep_id)
    if sweep is None:
        raise HTTPException(status_code=404, detail="Sweep not found")
    return SweepOut.model_validate(sweep)


@router.get("/{sweep_id}/runs", response_model=list[RunOut])
async def get_sweep_runs(sweep_id: int, db: AsyncSession = Depends(get_db)):
    sweep = await db.get(Sweep, sweep_id)
    if sweep is None:
        raise HTTPException(status_code=404, detail="Sweep not found")

    result = await db.execute(
        select(Run)
        .options(selectinload(Run.metrics))
        .where(Run.sweep_id == sweep_id)
        .order_by(Run.started_at.asc())
    )
    runs = result.scalars().all()
    return [RunOut.model_validate(r) for r in runs]


@router.delete("/{sweep_id}", status_code=204)
async def delete_sweep(sweep_id: int, db: AsyncSession = Depends(get_db)):
    sweep = await db.get(Sweep, sweep_id)
    if sweep is None:
        raise HTTPException(status_code=404, detail="Sweep not found")

    # Cancel any pending/running runs for this sweep
    result = await db.execute(
        select(Run).where(
            Run.sweep_id == sweep_id,
            Run.status.in_(["pending", "running"]),
        )
    )
    pending_runs = result.scalars().all()
    for run in pending_runs:
        try:
            await runner.stop(run.id)
        except Exception as exc:
            logger.warning("Could not stop run %d: %s", run.id, exc)
        run.status = RunStatus.cancelled.value
        run.completed_at = datetime.utcnow()

    sweep.status = "cancelled"
    sweep.completed_at = datetime.utcnow()
    await db.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _apply_params(workload_yaml: str, params: dict) -> str:
    """
    Apply parameter overrides to a workload YAML string.

    Supports simple top-level keys and dot-separated nested keys,
    e.g. "partitionsPerTopic" or "producerConfig.batchSize".
    """
    data = yaml.safe_load(workload_yaml) or {}
    for key, value in params.items():
        parts = key.split(".")
        target = data
        for part in parts[:-1]:
            if part not in target or not isinstance(target[part], dict):
                target[part] = {}
            target = target[part]
        target[parts[-1]] = value
    return yaml.dump(data, default_flow_style=False)


def _combo_label(params: dict) -> str:
    """Build a short human-readable label for a parameter combination."""
    return ", ".join(f"{k}={v}" for k, v in params.items())


# ---------------------------------------------------------------------------
# Background task
# ---------------------------------------------------------------------------


async def _execute_sweep(
    sweep_id: int,
    run_ids: list[int],
    driver_base_content: str,
    workload_base_content: str,
    param_names: list[str],
    combinations: list[tuple],
    cooldown_seconds: int,
) -> None:
    """
    Execute sweep runs sequentially with cooldown between them.

    Each run is started, waited to completion (via _finish_run), and then
    the cooldown delay is observed before the next run starts.
    """
    for idx, (run_id, combo) in enumerate(zip(run_ids, combinations)):
        params = dict(zip(param_names, combo))
        workload_content = _apply_params(workload_base_content, params)

        # Mark run as running
        async with AsyncSessionLocal() as db:
            run = await db.get(Run, run_id)
            if run is None:
                continue
            # If sweep was cancelled, bail out
            sweep = await db.get(Sweep, sweep_id)
            if sweep is None or sweep.status == "cancelled":
                break
            run.status = RunStatus.running.value
            await db.commit()

        try:
            await runner.start(run_id, driver_base_content, workload_content)
        except Exception as exc:
            logger.error("Sweep %d: failed to start run %d: %s", sweep_id, run_id, exc)
            async with AsyncSessionLocal() as db:
                run = await db.get(Run, run_id)
                if run:
                    run.status = RunStatus.failed.value
                    run.completed_at = datetime.utcnow()
                    await db.commit()
            continue

        # Wait for this run to complete before starting next
        await _finish_run(run_id)

        # Cooldown between runs (not after the last one)
        if idx < len(run_ids) - 1:
            await asyncio.sleep(cooldown_seconds)

    # Mark sweep as completed (unless it was already cancelled)
    async with AsyncSessionLocal() as db:
        sweep = await db.get(Sweep, sweep_id)
        if sweep and sweep.status == "running":
            sweep.status = "completed"
            sweep.completed_at = datetime.utcnow()
            await db.commit()

    logger.info("Sweep %d finished", sweep_id)
