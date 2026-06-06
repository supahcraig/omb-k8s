"""
Sweeps router — multi-run benchmarks that iterate over parameter combinations.
"""
import asyncio
import itertools
import json
import logging
from datetime import datetime
from typing import Optional

import yaml
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from database import AsyncSessionLocal, get_db
from models import Run, RunResult, Sweep
from routers.runs import launch_run
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
        name=body.name or '',
        status="running",
        parameter_axes=json.dumps({
            **body.effective_workload_axes,
            **body.driver_parameter_axes,
        }),
        cooldown_seconds=body.cooldown_seconds,
    )
    db.add(sweep)
    await db.commit()
    await db.refresh(sweep)

    # Build cartesian product across workload axes and driver axes combined.
    param_names_workload = list(body.effective_workload_axes.keys())
    param_values_workload = [body.effective_workload_axes[k] for k in param_names_workload]
    param_names_driver = list(body.driver_parameter_axes.keys())
    param_values_driver = [body.driver_parameter_axes[k] for k in param_names_driver]

    all_param_names = param_names_workload + param_names_driver
    all_param_values = param_values_workload + param_values_driver
    combinations = list(itertools.product(*all_param_values)) if all_param_values else [()]

    workload_contents: list[str] = []
    driver_contents: list[str] = []
    run_ids: list[int] = []

    for combo in combinations:
        params = dict(zip(all_param_names, combo))
        workload_params = {k: v for k, v in params.items() if k in param_names_workload}
        driver_params = {k: v for k, v in params.items() if k in param_names_driver}

        workload_content = _apply_params(body.workload_content, workload_params)
        driver_content = _apply_params(body.driver_base_content, driver_params)
        workload_contents.append(workload_content)
        driver_contents.append(driver_content)

        run = Run(
            name=_combo_label(params),
            status="pending",
            driver_config=driver_content,
            workload_config=workload_content,
            sweep_id=sweep.id,
            sweep_params=json.dumps(params),
        )
        db.add(run)
        await db.flush()
        run_ids.append(run.id)

    await db.commit()

    background_tasks.add_task(
        _execute_sweep,
        sweep.id,
        run_ids,
        driver_contents,
        workload_contents,
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


@router.get("/{sweep_id}/visualization-data")
async def get_sweep_visualization_data(sweep_id: int, db: AsyncSession = Depends(get_db)):
    sweep = await db.get(Sweep, sweep_id)
    if sweep is None:
        raise HTTPException(status_code=404, detail="Sweep not found")

    result = await db.execute(
        select(Run)
        .where(Run.sweep_id == sweep_id)
        .order_by(Run.id.asc())
    )
    runs = result.scalars().all()

    run_ids = [r.id for r in runs]
    results_map: dict[int, RunResult] = {}
    if run_ids:
        rr_result = await db.execute(
            select(RunResult).where(RunResult.run_id.in_(run_ids))
        )
        for rr in rr_result.scalars().all():
            results_map[rr.run_id] = rr

    # Build labels; check for truncation collisions
    full_labels = [
        ", ".join(f"{k}={v}" for k, v in json.loads(r.sweep_params or "{}").items())
        for r in runs
    ]
    truncated = [lbl[:37] + "..." if len(lbl) > 40 else lbl for lbl in full_labels]
    labels = full_labels if len(set(truncated)) < len(truncated) else truncated

    run_data = []
    for run, label in zip(runs, labels):
        params = json.loads(run.sweep_params or "{}")
        rr = results_map.get(run.id)
        run_data.append({
            "run_id": run.id,
            "sweep_params": params,
            "label": label,
            "publish_p99":  rr.publish_p99  if rr else None,
            "publish_p999": rr.publish_p999 if rr else None,
            "e2e_p99":      rr.e2e_p99      if rr else None,
            "e2e_p999":     rr.e2e_p999     if rr else None,
            "publish_quantiles": json.loads(rr.publish_quantiles_json) if rr and rr.publish_quantiles_json else None,
            "e2e_quantiles":     json.loads(rr.e2e_quantiles_json)     if rr and rr.e2e_quantiles_json     else None,
        })

    return {
        "sweep": {
            "id": sweep.id,
            "name": sweep.name,
            "parameter_axes": json.loads(sweep.parameter_axes or "{}"),
        },
        "runs": run_data,
    }


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


_PROPERTIES_FIELDS = {"producerConfig", "consumerConfig", "topicConfig"}


def _apply_params(workload_yaml: str, params: dict) -> str:
    """
    Apply parameter overrides to a YAML string.

    Supports simple top-level keys and dot-separated nested keys.  For driver
    YAML fields that OMB expects as Java Properties strings (producerConfig,
    consumerConfig, topicConfig), dot-separated keys like
    "producerConfig.acks" are handled as property updates inside that string
    rather than YAML nesting — preserving the string type Jackson requires.
    """
    data = yaml.safe_load(workload_yaml) or {}
    for key, value in params.items():
        parts = key.split(".")
        if parts[0] in _PROPERTIES_FIELDS and len(parts) > 1:
            prop_field = parts[0]
            prop_key = ".".join(parts[1:])
            existing = data.get(prop_field) or ""
            props = _parse_properties(existing)
            props[prop_key] = str(value)
            data[prop_field] = _dump_properties(props)
        else:
            target = data
            for part in parts[:-1]:
                if part not in target or not isinstance(target[part], dict):
                    target[part] = {}
                target = target[part]
            target[parts[-1]] = value
    return yaml.dump(data, default_flow_style=False)


def _parse_properties(s: str) -> dict:
    result = {}
    for line in (s or "").splitlines():
        line = line.strip()
        if "=" in line:
            k, _, v = line.partition("=")
            result[k.strip()] = v.strip()
    return result


def _dump_properties(props: dict) -> str:
    return "\n".join(f"{k}={v}" for k, v in props.items())


def _combo_label(params: dict) -> str:
    """Build a short human-readable label for a parameter combination."""
    def _short_key(k: str) -> str:
        for prefix in ("producerConfig.", "consumerConfig.", "topicConfig."):
            if k.startswith(prefix):
                return k[len(prefix):]
        return k
    return ", ".join(f"{_short_key(k)}={v}" for k, v in params.items())


# ---------------------------------------------------------------------------
# Background task
# ---------------------------------------------------------------------------


async def _execute_sweep(
    sweep_id: int,
    run_ids: list[int],
    driver_contents: list[str],
    workload_contents: list[str],
    cooldown_seconds: int,
) -> None:
    """
    Execute sweep runs sequentially with cooldown between them.

    driver_contents and workload_contents are parallel lists — each index
    corresponds to the same run_id.  Both lists contain pre-computed per-run
    YAML matching what was stored in the DB at creation time.
    """
    for idx, (run_id, driver_content, workload_content) in enumerate(
        zip(run_ids, driver_contents, workload_contents)
    ):

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
            await launch_run(run_id, driver_content, workload_content, await_finish=True)
        except Exception as exc:
            logger.error("Sweep %d: failed to start run %d: %s", sweep_id, run_id, exc)
            async with AsyncSessionLocal() as db:
                run = await db.get(Run, run_id)
                if run:
                    run.status = RunStatus.failed.value
                    run.error_message = str(exc)
                    run.completed_at = datetime.utcnow()
                    await db.commit()
            continue

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
