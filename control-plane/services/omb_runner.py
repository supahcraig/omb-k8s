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
from typing import Optional

from kubernetes import client as k8s_client
from kubernetes import watch as k8s_watch

from config import settings
from services.k8s_client import load_incluster_once, run_sync

logger = logging.getLogger(__name__)


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

        # 2. Query StatefulSet replica count
        apps_api = k8s_client.AppsV1Api()
        sts = await run_sync(
            apps_api.read_namespaced_stateful_set, "omb-worker", namespace
        )
        replica_count: int = sts.spec.replicas or 1
        logger.info("omb-worker StatefulSet has %d replica(s)", replica_count)

        # 3. Construct --workers argument
        workers_arg = ",".join(
            f"http://omb-worker-{i}.omb-worker.{namespace}.svc.cluster.local:8080"
            for i in range(replica_count)
        )

        # Parse messageSize so the init container generates the right payload size
        import yaml as _yaml
        try:
            _wl = _yaml.safe_load(workload_content) or {}
            message_size = int(_wl.get("messageSize", 1024))
        except Exception:
            message_size = 1024

        # 4. Create Job
        job = k8s_client.V1Job(
            metadata=k8s_client.V1ObjectMeta(name=job_name, namespace=namespace),
            spec=k8s_client.V1JobSpec(
                ttl_seconds_after_finished=300,
                backoff_limit=0,
                template=k8s_client.V1PodTemplateSpec(
                    spec=k8s_client.V1PodSpec(
                        restart_policy="Never",
                        init_containers=[
                            k8s_client.V1Container(
                                name="gen-payload",
                                image="busybox:latest",
                                command=[
                                    "dd", "if=/dev/urandom",
                                    "of=/payload/payload.data",
                                    f"bs={message_size}", "count=1",
                                ],
                                volume_mounts=[
                                    k8s_client.V1VolumeMount(
                                        name="payload", mount_path="/payload"
                                    )
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
                                    "/tmp/omb-results",
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
                        ],
                    )
                ),
            ),
        )
        batch_api = k8s_client.BatchV1Api()
        await run_sync(batch_api.create_namespaced_job, namespace, job)
        logger.info("Created Job %s in namespace %s", job_name, namespace)

        # 5. Initialise state and kick off background log streaming
        self._active[run_id] = {"lines": [], "done": False, "success": False}
        asyncio.create_task(self._stream_logs(run_id, job_name))

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
