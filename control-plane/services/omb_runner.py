"""
OMB benchmark runner — creates and monitors k8s Jobs.

Each benchmark run maps to:
  - a ConfigMap  omb-run-{run_id}  containing driver.yaml + workload.yaml
  - a k8s Job    omb-run-{run_id}  that mounts the ConfigMap and runs the
                                   OMB driver process

The runner is a singleton (module-level ``runner`` instance).  Callers import:

    from services.omb_runner import runner
"""
import asyncio
import logging
from datetime import datetime
from typing import Optional

import httpx
from kubernetes import client as k8s_client
from kubernetes import watch as k8s_watch
from sqlalchemy import update

from config import settings
from database import AsyncSessionLocal
from models import Run, WorkerPool
from services.k8s_client import load_incluster_once, run_sync
from services.worker_pool_manager import (
    build_workers_arg,
    cancel_teardown,
    claim_pool,
)

logger = logging.getLogger(__name__)


async def _record_phase_ts(
    run_id: int,
    *,
    warmup_started_at: Optional[datetime] = None,
    benchmark_started_at: Optional[datetime] = None,
) -> None:
    """Write warmup/benchmark phase timestamps to the DB when first detected."""
    values: dict = {}
    if warmup_started_at is not None:
        values["warmup_started_at"] = warmup_started_at
    if benchmark_started_at is not None:
        values["benchmark_started_at"] = benchmark_started_at
    if not values:
        return
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(update(Run).where(Run.id == run_id).values(**values))
            await session.commit()
    except Exception as exc:
        logger.warning("Failed to record phase timestamp for run %d: %s", run_id, exc)


class OmbRunner:
    """Singleton that manages active benchmark runs as k8s Jobs."""

    def __init__(self) -> None:
        # {run_id: {"lines": list[str], "done": bool, "success": bool}}
        self._active: dict[int, dict] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def start(
        self,
        run_id: int,
        driver_content: str,
        workload_content: str,
        worker_image: Optional[str] = None,
    ) -> None:
        """
        Launch a benchmark run as a k8s Job.

        Steps:
          1. Create ConfigMap omb-run-{run_id} with driver.yaml + workload.yaml
          2. Query StatefulSet omb-worker for current replica count
          3. Build --workers argument from replica count
          4. Create k8s Job mounting the ConfigMap
          5. Initialise state and start background log-streaming task
        """
        if worker_image is None:
            worker_image = settings.worker_image

        load_incluster_once()

        job_name = f"omb-run-{run_id}"
        configmap_name = f"omb-run-{run_id}"
        namespace = settings.omb_namespace

        # 0. Claim a worker pool (default or new concurrent pool) and probe workers.
        #    /stop-all is safe on healthy idle workers (200 OK) but returns 500
        #    on workers stuck from a prior cancelled run.
        pool: WorkerPool = await claim_pool(run_id, namespace)
        logger.info(
            "Run %d using pool %s (%d worker(s))", run_id, pool.id, pool.replicas
        )
        await self._probe_workers(pool, namespace)

        # Pool claimed and workers healthy — transition run to "running" and record pool.
        async with AsyncSessionLocal() as db:
            await db.execute(
                update(Run).where(Run.id == run_id).values(
                    worker_pool_id=pool.id,
                    status="running",
                )
            )
            await db.commit()

        # 1. Create ConfigMap
        core_api = k8s_client.CoreV1Api()
        cm = k8s_client.V1ConfigMap(
            metadata=k8s_client.V1ObjectMeta(
                name=configmap_name,
                namespace=namespace,
            ),
            data={
                "driver.yaml": driver_content,
                "workload.yaml": workload_content,
            },
        )
        await run_sync(core_api.create_namespaced_config_map, namespace, cm)
        logger.info("Created ConfigMap %s in namespace %s", configmap_name, namespace)

        # 2. Construct --workers argument from pool
        workers_arg = build_workers_arg(pool, namespace, settings.omb_worker_port)

        # Parse messageSize so the init container generates the right payload size
        import yaml as _yaml
        try:
            _wl = _yaml.safe_load(workload_content) or {}
            message_size = int(_wl.get("messageSize", 1024))
        except Exception:
            message_size = 1024

        results_path = f"/data/results/run-{run_id}"

        # 4. Create Job
        job = k8s_client.V1Job(
            metadata=k8s_client.V1ObjectMeta(name=job_name, namespace=namespace),
            spec=k8s_client.V1JobSpec(
                ttl_seconds_after_finished=600,
                backoff_limit=0,
                template=k8s_client.V1PodTemplateSpec(
                    spec=k8s_client.V1PodSpec(
                        restart_policy="Never",
                        # Must run on the same node as the control-plane pod so
                        # the ReadWriteOnce data PVC can be mounted by both pods
                        # simultaneously (EBS allows multiple pods per node).
                        affinity=k8s_client.V1Affinity(
                            pod_affinity=k8s_client.V1PodAffinity(
                                required_during_scheduling_ignored_during_execution=[
                                    k8s_client.V1PodAffinityTerm(
                                        label_selector=k8s_client.V1LabelSelector(
                                            match_labels={"app": "omb-control-plane"}
                                        ),
                                        topology_key="kubernetes.io/hostname",
                                    )
                                ]
                            )
                        ),
                        init_containers=[
                            k8s_client.V1Container(
                                name="gen-payload",
                                image="busybox:latest",
                                command=[
                                    "sh", "-c",
                                    f"mkdir -p /data/results && "
                                    f"dd if=/dev/urandom of=/payload/payload.data "
                                    f"bs={message_size} count=1",
                                ],
                                volume_mounts=[
                                    k8s_client.V1VolumeMount(
                                        name="payload", mount_path="/payload"
                                    ),
                                    k8s_client.V1VolumeMount(
                                        name="data", mount_path="/data"
                                    ),
                                ],
                            )
                        ],
                        containers=[
                            k8s_client.V1Container(
                                name="driver",
                                image=worker_image,
                                image_pull_policy="Always",
                                env=[
                                    k8s_client.V1EnvVar(name="OMB_MODE", value="driver")
                                ],
                                args=[
                                    "--drivers",
                                    "/etc/omb/driver.yaml",
                                    "/etc/omb/workload.yaml",
                                    "--workers",
                                    workers_arg,
                                    "--output",
                                    results_path,
                                ],
                                volume_mounts=[
                                    k8s_client.V1VolumeMount(
                                        name="omb-config",
                                        mount_path="/etc/omb",
                                    ),
                                    k8s_client.V1VolumeMount(
                                        name="payload",
                                        mount_path="/payload",
                                    ),
                                    k8s_client.V1VolumeMount(
                                        name="data",
                                        mount_path="/data",
                                    ),
                                ],
                            )
                        ],
                        volumes=[
                            k8s_client.V1Volume(
                                name="omb-config",
                                config_map=k8s_client.V1ConfigMapVolumeSource(
                                    name=configmap_name
                                ),
                            ),
                            k8s_client.V1Volume(
                                name="payload",
                                empty_dir=k8s_client.V1EmptyDirVolumeSource(),
                            ),
                            k8s_client.V1Volume(
                                name="data",
                                persistent_volume_claim=k8s_client.V1PersistentVolumeClaimVolumeSource(
                                    claim_name="omb-control-plane-data"
                                ),
                            ),
                        ],
                    )
                ),
            ),
        )
        batch_api = k8s_client.BatchV1Api()
        await run_sync(batch_api.create_namespaced_job, namespace, job)
        logger.info("Created Job %s in namespace %s", job_name, namespace)

        # 5. Initialise state and kick off background log streaming
        self._active[run_id] = {
            "lines": [], "done": False, "success": False,
            "warmup_started_at": None, "benchmark_started_at": None,
            "pool_id": pool.id,
        }
        asyncio.create_task(self._stream_logs(run_id, job_name))
        return pool

    async def _probe_workers(self, pool: WorkerPool, namespace: str) -> None:
        """
        POST /stop-all to every worker pod in the given pool concurrently.

        A healthy idle worker returns 200. A worker stuck from a prior cancelled
        run returns 500. Raises RuntimeError listing every unhealthy worker so
        the caller can surface a clear message to the SE.
        """
        async def _probe_one(idx: int) -> Optional[str]:
            url = (
                f"http://{pool.statefulset_name}-{idx}.{pool.service_name}"
                f".{namespace}.svc.cluster.local:{settings.omb_worker_port}/stop-all"
            )
            def _sync_post() -> int:
                with httpx.Client(timeout=3.0) as client:
                    return client.post(url).status_code
            try:
                status = await asyncio.to_thread(_sync_post)
                if status != 200:
                    return (
                        f"{pool.statefulset_name}-{idx} is not ready (HTTP {status}) — "
                        "it may be stuck from a previous cancelled run. "
                        "Go to the Cluster tab and restart it before running."
                    )
            except Exception as exc:
                return (
                    f"{pool.statefulset_name}-{idx} is unreachable ({exc}) — "
                    "verify the worker pod is Running in the Cluster tab."
                )
            return None

        results = await asyncio.gather(*[_probe_one(i) for i in range(pool.replicas)])
        errors = [r for r in results if r is not None]
        if errors:
            raise RuntimeError("; ".join(errors))

    async def stop(self, run_id: int) -> None:
        """Delete the k8s Job (and its pods) for the given run."""
        job_name = f"omb-run-{run_id}"
        load_incluster_once()
        batch_api = k8s_client.BatchV1Api()
        try:
            await run_sync(
                batch_api.delete_namespaced_job,
                job_name,
                settings.omb_namespace,
                body=k8s_client.V1DeleteOptions(propagation_policy="Foreground"),
            )
            logger.info("Deleted Job %s", job_name)
        except k8s_client.ApiException as exc:
            if exc.status != 404:
                raise
            logger.debug("Job %s not found (already deleted?)", job_name)

        if run_id in self._active:
            self._active[run_id]["done"] = True

    def get_lines(self, run_id: int) -> list:
        """Return all log lines collected so far for the run."""
        state = self._active.get(run_id)
        if state is None:
            return []
        return list(state["lines"])

    def is_started(self, run_id: int) -> bool:
        """Return True once runner.start() has registered this run."""
        return run_id in self._active

    def is_done(self, run_id: int) -> bool:
        """Return True if the run's Job has completed or failed."""
        state = self._active.get(run_id)
        if state is None:
            return True
        return bool(state["done"])

    def succeeded(self, run_id: int) -> bool:
        """Return True if the run's Job completed successfully."""
        state = self._active.get(run_id)
        if state is None:
            return False
        return bool(state["success"])

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _stream_logs(self, run_id: int, job_name: str) -> None:
        """
        Background task: wait for the Job pod, then stream its logs incrementally.

        Each log line is appended to state["lines"] as it arrives so callers
        polling get_lines() see output in real time during the run.

        All k8s API calls use run_sync() — the kubernetes client is synchronous.
        """
        state = self._active[run_id]
        namespace = settings.omb_namespace
        core_api = k8s_client.CoreV1Api()
        batch_api = k8s_client.BatchV1Api()

        # --- Wait for a pod to appear (up to 60 s) ---
        pod_name: Optional[str] = None
        for _ in range(60):
            await asyncio.sleep(1)
            try:
                pods = await run_sync(
                    core_api.list_namespaced_pod,
                    namespace,
                    label_selector=f"job-name={job_name}",
                )
                if pods.items:
                    pod_name = pods.items[0].metadata.name
                    break
            except Exception as exc:
                logger.warning("Error listing pods for job %s: %s", job_name, exc)

        if not pod_name:
            msg = f"[omb-runner] Timed out waiting for pod for job {job_name}"
            logger.error(msg)
            state["lines"].append(msg)
            state["done"] = True
            return

        logger.info("Streaming logs from pod %s (job %s)", pod_name, job_name)

        # --- Wait for pod to reach a loggable phase (up to 240 s) ---
        for _ in range(120):
            await asyncio.sleep(2)
            try:
                pod = await run_sync(
                    core_api.read_namespaced_pod, pod_name, namespace
                )
                phase = pod.status.phase if pod.status else None
                if phase in ("Running", "Succeeded", "Failed"):
                    break
            except Exception as exc:
                logger.warning("Error reading pod %s: %s", pod_name, exc)

        # --- Stream logs incrementally ---
        # _do_stream runs in an executor thread. It appends each line directly
        # to state["lines"] as it arrives — thread-safe via CPython's GIL for
        # list.append. This lets get_lines() return partial output in real time.
        # Capture the running loop before entering the thread so we can safely
        # schedule async DB writes from the thread via call_soon_threadsafe.
        loop = asyncio.get_event_loop()

        def _do_stream() -> None:
            w = k8s_watch.Watch()
            try:
                for event in w.stream(
                    core_api.read_namespaced_pod_log,
                    name=pod_name,
                    namespace=namespace,
                    container="driver",
                    follow=True,
                    _request_timeout=3600,
                ):
                    state["lines"].append(event)
                    if state["warmup_started_at"] is None and "Starting warm-up traffic" in event:
                        ts = datetime.utcnow()
                        state["warmup_started_at"] = ts
                        loop.call_soon_threadsafe(
                            asyncio.ensure_future,
                            _record_phase_ts(run_id, warmup_started_at=ts),
                        )
                    elif state["benchmark_started_at"] is None and "Starting benchmark traffic" in event:
                        ts = datetime.utcnow()
                        state["benchmark_started_at"] = ts
                        loop.call_soon_threadsafe(
                            asyncio.ensure_future,
                            _record_phase_ts(run_id, benchmark_started_at=ts),
                        )
            except Exception as exc:
                state["lines"].append(f"[omb-runner] Log streaming error: {exc}")

        try:
            await run_sync(_do_stream)
        except Exception as exc:
            state["lines"].append(f"[omb-runner] Executor error: {exc}")

        # Fetch the complete log once more after the container exits.
        # follow=True occasionally misses the last few lines before shutdown;
        # a non-follow read on the completed pod returns the full buffer.
        try:
            complete = await run_sync(
                core_api.read_namespaced_pod_log,
                pod_name,
                namespace,
                container="driver",
            )
            if complete:
                final_lines = [l for l in complete.split("\n") if l.strip()]
                if len(final_lines) > len(state["lines"]):
                    state["lines"] = final_lines
        except Exception:
            pass  # keep whatever follow=True captured

        # --- Determine success ---
        try:
            job = await run_sync(
                batch_api.read_namespaced_job, job_name, namespace
            )
            state["success"] = bool(
                job.status.succeeded and job.status.succeeded > 0
            )
        except Exception as exc:
            logger.warning("Could not read job status for %s: %s", job_name, exc)
            state["success"] = False

        state["done"] = True
        logger.info(
            "Run %d finished — success=%s, lines=%d",
            run_id,
            state["success"],
            len(state["lines"]),
        )

        # --- Cleanup ConfigMap ---
        try:
            await run_sync(
                core_api.delete_namespaced_config_map,
                f"omb-run-{run_id}",
                namespace,
            )
            logger.debug("Deleted ConfigMap omb-run-%d", run_id)
        except Exception as exc:
            logger.debug("Could not delete ConfigMap omb-run-%d: %s", run_id, exc)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

runner = OmbRunner()
