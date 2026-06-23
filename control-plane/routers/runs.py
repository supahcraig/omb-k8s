"""
Runs router — create, list, retrieve, and cancel benchmark runs.
"""
import asyncio
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, outerjoin
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from config import settings
from database import AsyncSessionLocal, get_db
from models import Metrics, Run, Sweep
from schemas import RunListItem, RunOut, RunStatus
from services.k8s_resources import read_worker_resources
from services.omb_runner import runner
from services.prometheus_collector import collect_prometheus, probe_broker_prometheus
from services.result_parser import parse_result_from_file, parse_result_from_logs
from services.worker_pool_manager import claim_pool, release_pool

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Request body
# ---------------------------------------------------------------------------


class RunCreate(BaseModel):
    name: Optional[str] = None
    driver_content: str
    workload_content: str
    pool_id: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("", response_model=list[RunListItem])
async def list_runs(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Run, Sweep.name.label("sweep_name"))
        .outerjoin(Sweep, Run.sweep_id == Sweep.id)
        .options(selectinload(Run.metrics))
        .order_by(Run.started_at.desc())
    )
    rows = result.all()

    items = []
    for run, sweep_name in rows:
        m = run.metrics
        items.append(
            RunListItem(
                id=run.id,
                name=run.name,
                status=run.status,
                started_at=run.started_at,
                completed_at=run.completed_at,
                sweep_id=run.sweep_id,
                sweep_name=sweep_name,
                publish_rate_avg=m.publish_rate_avg if m else None,
                publish_latency_avg=m.publish_latency_avg if m else None,
                publish_latency_p99=m.publish_latency_p99 if m else None,
                publish_latency_p999=m.publish_latency_p999 if m else None,
                end_to_end_latency_avg=m.end_to_end_latency_avg if m else None,
                end_to_end_latency_p99=m.end_to_end_latency_p99 if m else None,
                end_to_end_latency_p999=m.end_to_end_latency_p999 if m else None,
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
        driver_config=body.driver_content,
        workload_config=body.workload_content,
        # status defaults to "pending" — transitions to "running" once pool is ready
        # and the k8s Job is created. This allows the HTTP response to return
        # immediately instead of blocking for up to 300s on pool provisioning.
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)

    asyncio.create_task(_bg_launch(run.id, body.driver_content, body.workload_content, body.pool_id))

    result = await db.execute(
        select(Run).options(selectinload(Run.metrics)).where(Run.id == run.id)
    )
    run = result.scalar_one()
    return RunOut.model_validate(run)


async def _bg_launch(run_id: int, driver_content: str, workload_content: str, pool_id: str) -> None:
    """Background wrapper for launch_run — marks run failed on any exception."""
    try:
        await launch_run(run_id, driver_content, workload_content, pool_id)
    except Exception as exc:
        logger.error("Failed to start k8s Job for run %d: %s", run_id, exc)
        async with AsyncSessionLocal() as fail_db:
            fail_run = await fail_db.get(Run, run_id)
            if fail_run:
                fail_run.status = RunStatus.failed.value
                fail_run.error_message = str(exc)
                fail_run.completed_at = datetime.utcnow()
                await fail_db.commit()


@router.get("/timeline")
async def get_timeline(db: AsyncSession = Depends(get_db)):
    """
    Return all runs with timing columns for the Gantt chart.
    Ordered by started_at ascending so bars render chronologically.
    """
    result = await db.execute(
        select(Run).order_by(Run.started_at.asc())
    )
    runs = result.scalars().all()
    return [
        {
            "id": r.id,
            "name": r.name,
            "status": r.status,
            "started_at": r.started_at,
            "completed_at": r.completed_at,
            "warmup_started_at": r.warmup_started_at,
            "benchmark_started_at": r.benchmark_started_at,
            "sweep_id": r.sweep_id,
            "sweep_params": r.sweep_params,
            "worker_pool_id": r.worker_pool_id,
        }
        for r in runs
    ]


@router.get("/{run_id}/concurrent")
async def get_concurrent_runs(run_id: int, db: AsyncSession = Depends(get_db)):
    """
    Return runs whose started_at/completed_at overlap with this run's execution window.
    Excludes the run itself and its own sweep siblings.
    """
    run = await db.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")

    if run.completed_at is None:
        # Still running — overlap = started before now AND (still running OR ended after our start)
        stmt = select(Run).where(
            Run.id != run_id,
            Run.started_at < datetime.utcnow(),
            (Run.completed_at == None) | (Run.completed_at > run.started_at),
        )
    else:
        stmt = select(Run).where(
            Run.id != run_id,
            Run.started_at < run.completed_at,
            (Run.completed_at == None) | (Run.completed_at > run.started_at),
        )

    # Exclude sweep siblings (same sweep_id) — they're sequential, not concurrent.
    if run.sweep_id is not None:
        stmt = stmt.where((Run.sweep_id == None) | (Run.sweep_id != run.sweep_id))

    result = await db.execute(stmt.order_by(Run.started_at.asc()))
    overlapping = result.scalars().all()

    return [
        {
            "id": r.id,
            "name": r.name,
            "status": r.status,
            "started_at": r.started_at,
            "completed_at": r.completed_at,
            "workload_config": r.workload_config,
            "sweep_id": r.sweep_id,
        }
        for r in overlapping
    ]


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

    pool_id = run.worker_pool_id
    await runner.stop(run_id)
    run.status = RunStatus.cancelled.value
    run.completed_at = datetime.utcnow()
    await db.commit()
    if pool_id:
        await release_pool(pool_id)


@router.get("/{run_id}/results")
async def get_run_results(run_id: int):
    """Return HDR percentile results for a completed run. 404 if not yet available."""
    from services.hdr_result_parser import _find_result_file, parse_hdr_results_from_file

    path = _find_result_file(run_id)
    if not path:
        raise HTTPException(status_code=404, detail="Result file not available yet")

    parsed = parse_hdr_results_from_file(path)
    if not parsed:
        raise HTTPException(status_code=404, detail="Result file could not be parsed")

    return parsed


# ---------------------------------------------------------------------------
# Broker Prometheus probe helpers
# ---------------------------------------------------------------------------

import json as _json
from models import Setting as _Setting


async def _load_broker_targets() -> list:
    """Return scrape targets from stored Prometheus settings, or [] if none."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(_Setting).where(_Setting.key == 'prometheus'))
        row = result.scalars().first()
        if not row:
            return []
        stored = _json.loads(row.value or '{}')
        # self-hosted: comma-separated scrape_targets_str
        scrape_str = stored.get('scrape_targets_str') or ''
        if scrape_str:
            return [t.strip() for t in scrape_str.split(',') if t.strip()]
        # byoc: extract targets from scrape_yaml static_configs
        scrape_yaml = stored.get('scrape_yaml') or ''
        if scrape_yaml:
            import re
            targets = re.findall(r"['\"]([^'\"]+:\d+)['\"]", scrape_yaml)
            return targets
        return []


# ---------------------------------------------------------------------------
# Shared run lifecycle — used by single runs and sweeps
# ---------------------------------------------------------------------------


async def launch_run(
    run_id: int,
    driver_content: str,
    workload_content: str,
    pool_id: str,
    *,
    await_finish: bool = False,
) -> None:
    """
    Claim the specified pool, start a k8s Job, kick off the Prometheus collector,
    and handle completion.

    await_finish=False (default): _finish_run runs as a background task so the
    caller returns immediately. Used by single runs via create_run.

    await_finish=True: _finish_run is awaited inline so the caller blocks until
    the run completes. Used by _execute_sweep to enforce sequential execution.

    Raises on claim_pool or runner.start() failure — callers mark the run failed
    and surface the error as appropriate (HTTP 503 vs sweep continue).
    """
    pool = await claim_pool(pool_id, run_id)
    await runner.start(run_id, driver_content, workload_content, pool)
    prom_url = (
        f"http://omb-kube-prometheus-stack-prometheus"
        f".{settings.omb_namespace}.svc.cluster.local:9090"
    )
    cpu_request_cores, _ = await read_worker_resources(settings.omb_namespace)
    asyncio.create_task(
        collect_prometheus(
            run_id, settings.omb_namespace, prom_url, cpu_request_cores,
            statefulset_name=pool.statefulset_name,
        )
    )

    # Probe broker Prometheus endpoints (diagnostic logging only)
    broker_targets = await _load_broker_targets()
    if broker_targets:
        asyncio.create_task(probe_broker_prometheus(broker_targets))
    if await_finish:
        await _finish_run(run_id)
    else:
        asyncio.create_task(_finish_run(run_id))


# ---------------------------------------------------------------------------
# Topic cleanup
# ---------------------------------------------------------------------------

async def _delete_run_topics(run_id: int) -> None:
    """Delete all Kafka topics created for run_id (prefix omb-r{run_id})."""
    try:
        from aiokafka.admin import AIOKafkaAdminClient  # noqa: PLC0415
    except ImportError:
        logger.debug("_delete_run_topics: aiokafka not available, skipping")
        return

    from database import AsyncSessionLocal as _Session  # noqa: PLC0415
    from models import Setting  # noqa: PLC0415

    async with _Session() as db:
        row = await db.get(Setting, "cluster")
    if row is None:
        return
    import json as _json  # noqa: PLC0415
    cluster = _json.loads(row.value)

    bootstrap = cluster.get("bootstrap_servers", "").strip()
    if not bootstrap:
        return

    kwargs: dict = {"bootstrap_servers": bootstrap}

    tls_enabled = cluster.get("tls_enabled", False)
    tls_skip_verify = cluster.get("tls_skip_verify", False)
    tls_ca_cert = cluster.get("tls_ca_cert")
    sasl_enabled = cluster.get("sasl_enabled", False)
    sasl_mechanism = cluster.get("sasl_mechanism")
    sasl_username = cluster.get("sasl_username")
    sasl_password = cluster.get("sasl_password")

    if tls_enabled:
        import ssl  # noqa: PLC0415
        ssl_ctx = ssl.create_default_context()
        if tls_ca_cert:
            ssl_ctx.load_verify_locations(cadata=tls_ca_cert)
        if tls_skip_verify:
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE
        kwargs["ssl_context"] = ssl_ctx
        kwargs["security_protocol"] = "SASL_SSL" if sasl_enabled else "SSL"
    elif sasl_enabled:
        kwargs["security_protocol"] = "SASL_PLAINTEXT"

    if sasl_enabled and sasl_mechanism and sasl_username and sasl_password:
        kwargs["sasl_mechanism"] = sasl_mechanism
        kwargs["sasl_plain_username"] = sasl_username
        kwargs["sasl_plain_password"] = sasl_password

    prefix = f"omb-r{run_id}"
    admin = AIOKafkaAdminClient(**kwargs)
    try:
        await asyncio.wait_for(admin.start(), timeout=10.0)
        all_topics = await admin.list_topics()
        to_delete = [t for t in all_topics if t.startswith(prefix)]
        if to_delete:
            await admin.delete_topics(to_delete, timeout_ms=15000)
            logger.info("_delete_run_topics: deleted %d topic(s) for run %d", len(to_delete), run_id)
        else:
            logger.debug("_delete_run_topics: no topics found for run %d", run_id)
    except Exception as exc:
        logger.warning("_delete_run_topics: failed for run %d: %s", run_id, exc)
    finally:
        try:
            await admin.close()
        except Exception:
            pass


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

        if run.status == RunStatus.cancelled.value:
            logger.info("_finish_run: run %d was cancelled — pool already released", run_id)
            return

        lines = runner.get_lines(run_id)
        success = runner.succeeded(run_id)

        # Prefer the high-fidelity JSON file written by OMB's --output flag.
        # Fall back to log parsing if the file isn't present (old runs, file
        # write failure, or first run before the PVC path existed).
        results_file_path = f"/data/results/run-{run_id}"
        metrics_data = parse_result_from_file(results_file_path) or parse_result_from_logs(lines)

        # Rename the result file to a descriptive name so it persists on the PVC.
        import glob as _glob
        import os as _os
        candidates = _glob.glob(results_file_path) + _glob.glob(f"{results_file_path}*.json")
        if candidates:
            source = max(candidates, key=_os.path.getmtime)
            if run.sweep_id:
                dest = f"/data/results/sweep-{run.sweep_id}-run-{run_id}.json"
            else:
                dest = f"/data/results/run-{run_id}.json"
            try:
                _os.rename(source, dest)
            except Exception as exc:
                logger.warning("Could not rename result file %s -> %s: %s", source, dest, exc)

        # Parse HDR percentile data after the rename completes.
        from services.hdr_result_parser import parse_and_store_hdr_results as _parse_hdr
        asyncio.create_task(_parse_hdr(run_id))

        # Mark completed if we parsed metrics, regardless of Job exit code.
        # The aggregate summary line only appears on clean OMB completion, so
        # its presence is a reliable signal that results are valid.
        if metrics_data:
            run.status = RunStatus.completed.value
            metrics = Metrics(run_id=run_id, **metrics_data)
            db.add(metrics)
        else:
            run.status = RunStatus.failed.value
            run.error_message = (
                f"Benchmark completed without producing results "
                f"({len(lines)} log line(s) captured). "
                "Check the run log for initialization errors or OMB exceptions."
            )
            logger.warning(
                "_finish_run: run %d — no parseable metrics (success=%s, lines=%d)",
                run_id, success, len(lines),
            )

        run.completed_at = datetime.utcnow()
        pool_id = run.worker_pool_id

        try:
            await db.commit()
        except Exception:
            await db.rollback()
            logger.exception("_finish_run: DB commit failed for run %d", run_id)
            return

    logger.info("_finish_run: run %d finished — status=%s", run_id, run.status)

    # Delete topics when the driver had reset: true (OMB created them fresh).
    import yaml as _yaml  # noqa: PLC0415
    driver_yaml = run.driver_config or ""
    try:
        reset_flag = _yaml.safe_load(driver_yaml).get("reset", False)
    except Exception:
        reset_flag = False
    if reset_flag:
        asyncio.create_task(_delete_run_topics(run_id))

    # Release the pool back to ready so another run can claim it.
    if pool_id:
        await release_pool(pool_id)
