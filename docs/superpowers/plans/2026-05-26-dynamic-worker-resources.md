# Dynamic Worker Resource Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded worker CPU/memory/JVM values with a single Helm-driven source of truth so changing instance types requires only two changes (Terraform + values file).

**Architecture:** Helm values drive the StatefulSet container resources; the JVM reads its own cgroup memory limit at startup via `MaxRAMPercentage`; a new `/api/workers/resources` endpoint reads the live StatefulSet spec and returns parsed CPU/memory values to both the Prometheus collector (CPU % divisor) and the React charts (reference line + domain). No CPU limits are set on worker pods — throttling is architecturally prevented.

**Tech Stack:** Helm, Kubernetes Python SDK, FastAPI/Pydantic, React + Recharts, Vitest

---

## File Map

| File | Status | Purpose |
|------|--------|---------|
| `worker/entrypoint.sh` | Modify | Replace fixed heap flags with `MaxRAMPercentage=75.0` |
| `charts/omb/templates/worker/statefulset.yaml` | Modify | Use Helm values for resources; CPU request only, no limit |
| `charts/omb/values.yaml` | Modify | Add `worker.resources.cpu/memory` fallback defaults |
| `charts/omb/values-aws.yaml` | Modify | Add m5.4xlarge-appropriate resource values |
| `charts/omb/values-gcp.yaml` | Modify | Add n2-standard-16-appropriate resource values |
| `charts/omb/values-aks.yaml` | Modify | Add Standard_D16s_v3-appropriate resource values |
| `control-plane/services/k8s_resources.py` | **Create** | `parse_cpu`, `parse_memory_mib`, `read_worker_resources` |
| `control-plane/tests/test_k8s_resources.py` | **Create** | Unit tests for parsing functions |
| `control-plane/schemas.py` | Modify | Add `WorkerResources` response schema |
| `control-plane/routers/workers.py` | Modify | Add `GET /api/workers/resources` endpoint |
| `control-plane/services/prometheus_collector.py` | Modify | Replace `CPU_LIMIT_CORES = 4.0` with `cpu_request_cores` param |
| `control-plane/routers/runs.py` | Modify | Fetch worker resources in `launch_run()`, pass to collector |
| `control-plane/frontend/src/api.js` | Modify | Add `getWorkerResources()` |
| `control-plane/frontend/src/pages/RunDetailPage.jsx` | Modify | Fetch resources on mount, pass to RunCharts |
| `control-plane/frontend/src/components/RunCharts.jsx` | Modify | Accept `workerMemLimitMiB`/`workerCpuCores` props; dynamic domain + reference line |
| `CLAUDE.md` | Modify | Update hardcoded "4 vCPU / 8GB" and JVM flags documentation |

---

## Task 1: Helm chart — StatefulSet resources template

**Files:**
- Modify: `charts/omb/templates/worker/statefulset.yaml:44-50`
- Modify: `charts/omb/values.yaml:1-5`
- Modify: `charts/omb/values-aws.yaml`
- Modify: `charts/omb/values-gcp.yaml`
- Modify: `charts/omb/values-aks.yaml`

- [ ] **Step 1: Update StatefulSet template to use Helm values**

In `charts/omb/templates/worker/statefulset.yaml`, replace lines 44–50:

```yaml
          resources:
            requests:
              cpu: "4"
              memory: 8Gi
            limits:
              cpu: "4"
              memory: 8Gi
```

With (CPU request only — no CPU limit):

```yaml
          resources:
            requests:
              cpu: {{ .Values.worker.resources.cpu | quote }}
              memory: {{ .Values.worker.resources.memory | quote }}
            limits:
              memory: {{ .Values.worker.resources.memory | quote }}
```

- [ ] **Step 2: Add resource defaults to values.yaml**

In `charts/omb/values.yaml`, after `tag: latest` (line 4), add:

```yaml
  resources:
    cpu: "4"
    memory: "8Gi"
```

Full `worker` block after the change:
```yaml
worker:
  replicas: 2
  image:
    repository: ghcr.io/supahcraig/omb-worker
    tag: latest
  resources:
    cpu: "4"
    memory: "8Gi"
```

- [ ] **Step 3: Add m5.4xlarge values to values-aws.yaml**

Append to the end of `charts/omb/values-aws.yaml`:

```yaml

worker:
  resources:
    cpu: "15"
    memory: "60Gi"
```

- [ ] **Step 4: Add n2-standard-16 values to values-gcp.yaml**

`charts/omb/values-gcp.yaml` currently contains only `storage.storageClassName`. Append:

```yaml

worker:
  resources:
    cpu: "15"
    memory: "58Gi"
```

- [ ] **Step 5: Add Standard_D16s_v3 values to values-aks.yaml**

`charts/omb/values-aks.yaml` currently contains only `storage.storageClassName`. Append:

```yaml

worker:
  resources:
    cpu: "15"
    memory: "58Gi"
```

- [ ] **Step 6: Lint the chart**

```bash
helm lint charts/omb -f charts/omb/values-aws.yaml
```

Expected: `1 chart(s) linted, 0 chart(s) failed`

- [ ] **Step 7: Commit**

```bash
git add charts/omb/templates/worker/statefulset.yaml \
        charts/omb/values.yaml \
        charts/omb/values-aws.yaml \
        charts/omb/values-gcp.yaml \
        charts/omb/values-aks.yaml
git commit -m "feat: make worker container resources configurable via Helm values"
```

---

## Task 2: Worker entrypoint — percentage-based JVM heap

**Files:**
- Modify: `worker/entrypoint.sh:8-16`

- [ ] **Step 1: Replace fixed heap flags with percentage flags**

In `worker/entrypoint.sh`, replace the `JVM_OPTS` block:

```bash
JVM_OPTS="\
-Xms4G \
-Xmx4G \
-XX:+UseContainerSupport \
-XX:+UseG1GC \
-XX:MaxGCPauseMillis=10 \
-XX:+ParallelRefProcEnabled \
-XX:+PerfDisableSharedMem \
-XX:+DisableExplicitGC"
```

With:

```bash
JVM_OPTS="\
-XX:InitialRAMPercentage=75.0 \
-XX:MaxRAMPercentage=75.0 \
-XX:+UseContainerSupport \
-XX:+UseG1GC \
-XX:MaxGCPauseMillis=10 \
-XX:+ParallelRefProcEnabled \
-XX:+PerfDisableSharedMem \
-XX:+DisableExplicitGC"
```

`UseContainerSupport` is already present and is what enables `MaxRAMPercentage` to read cgroup limits correctly.

- [ ] **Step 2: Commit**

```bash
git add worker/entrypoint.sh
git commit -m "feat: replace fixed JVM heap with MaxRAMPercentage=75 for dynamic sizing"
```

---

## Task 3: k8s resource parsing service (TDD)

**Files:**
- Create: `control-plane/services/k8s_resources.py`
- Create: `control-plane/tests/test_k8s_resources.py`

- [ ] **Step 1: Install pytest**

```bash
cd control-plane && pip install pytest
```

Expected: `Successfully installed pytest-...`

- [ ] **Step 2: Create test file**

Create `control-plane/tests/__init__.py` (empty) and `control-plane/tests/test_k8s_resources.py`:

```python
import pytest
from services.k8s_resources import parse_cpu, parse_memory_mib


class TestParseCpu:
    def test_integer_string(self):
        assert parse_cpu("15") == 15.0

    def test_single_core(self):
        assert parse_cpu("4") == 4.0

    def test_millicores(self):
        assert parse_cpu("500m") == 0.5

    def test_millicores_small(self):
        assert parse_cpu("250m") == 0.25


class TestParseMemoryMib:
    def test_gibibytes(self):
        assert parse_memory_mib("60Gi") == 61440

    def test_8_gib(self):
        assert parse_memory_mib("8Gi") == 8192

    def test_58_gib(self):
        assert parse_memory_mib("58Gi") == 59392

    def test_mibibytes(self):
        assert parse_memory_mib("512Mi") == 512

    def test_1_mib(self):
        assert parse_memory_mib("1Mi") == 1
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
cd control-plane && python -m pytest tests/test_k8s_resources.py -v
```

Expected: `ModuleNotFoundError: No module named 'services.k8s_resources'`

- [ ] **Step 4: Create k8s_resources.py with parsing functions**

Create `control-plane/services/k8s_resources.py`:

```python
import logging

logger = logging.getLogger(__name__)

_FALLBACK_CPU_CORES = 4.0
_FALLBACK_MEM_MIB = 8192


def parse_cpu(value: str) -> float:
    """Parse a Kubernetes CPU quantity string to float cores.

    Examples: "15" -> 15.0, "500m" -> 0.5
    """
    if value.endswith("m"):
        return int(value[:-1]) / 1000.0
    return float(value)


def parse_memory_mib(value: str) -> int:
    """Parse a Kubernetes memory quantity string to integer MiB.

    Examples: "60Gi" -> 61440, "512Mi" -> 512
    """
    if value.endswith("Gi"):
        return int(value[:-2]) * 1024
    if value.endswith("Mi"):
        return int(value[:-2])
    if value.endswith("Ki"):
        return max(1, int(value[:-2]) // 1024)
    # Plain bytes
    return max(1, int(value) // (1024 * 1024))


async def read_worker_resources(namespace: str) -> tuple[float, int]:
    """Read worker CPU request (cores) and memory limit (MiB) from the StatefulSet.

    Returns fallback values (4.0 cores, 8192 MiB) if the k8s API is unreachable.
    """
    from kubernetes import client as k8s_client
    from services.k8s_client import load_incluster_once, run_sync

    load_incluster_once()
    apps_api = k8s_client.AppsV1Api()
    try:
        sts = await run_sync(
            apps_api.read_namespaced_stateful_set, "omb-worker", namespace
        )
        container = next(
            (c for c in sts.spec.template.spec.containers if c.name == "worker"),
            None,
        )
        if container and container.resources:
            requests = container.resources.requests or {}
            limits = container.resources.limits or {}
            cpu_str = requests.get("cpu", str(_FALLBACK_CPU_CORES))
            mem_str = limits.get("memory", f"{_FALLBACK_MEM_MIB}Mi")
            return parse_cpu(cpu_str), parse_memory_mib(mem_str)
    except Exception as exc:
        logger.warning("Could not read worker resources from StatefulSet: %s", exc)
    return _FALLBACK_CPU_CORES, _FALLBACK_MEM_MIB
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd control-plane && python -m pytest tests/test_k8s_resources.py -v
```

Expected:
```
tests/test_k8s_resources.py::TestParseCpu::test_integer_string PASSED
tests/test_k8s_resources.py::TestParseCpu::test_single_core PASSED
tests/test_k8s_resources.py::TestParseCpu::test_millicores PASSED
tests/test_k8s_resources.py::TestParseCpu::test_millicores_small PASSED
tests/test_k8s_resources.py::TestParseMemoryMib::test_gibibytes PASSED
tests/test_k8s_resources.py::TestParseMemoryMib::test_8_gib PASSED
tests/test_k8s_resources.py::TestParseMemoryMib::test_58_gib PASSED
tests/test_k8s_resources.py::TestParseMemoryMib::test_mibibytes PASSED
tests/test_k8s_resources.py::TestParseMemoryMib::test_1_mib PASSED

9 passed in 0.XXs
```

- [ ] **Step 6: Commit**

```bash
git add control-plane/services/k8s_resources.py \
        control-plane/tests/__init__.py \
        control-plane/tests/test_k8s_resources.py
git commit -m "feat: add k8s resource parsing service with unit tests"
```

---

## Task 4: WorkerResources schema + API endpoint

**Files:**
- Modify: `control-plane/schemas.py:193-204` (Workers section)
- Modify: `control-plane/routers/workers.py`

- [ ] **Step 1: Add WorkerResources schema to schemas.py**

In `control-plane/schemas.py`, append to the Workers section (after `WorkerStatus`):

```python
class WorkerResources(BaseModel):
    cpu_request_cores: float
    memory_limit_mib: int
```

- [ ] **Step 2: Add the endpoint to workers.py**

In `control-plane/routers/workers.py`, update the imports at the top:

```python
from schemas import WorkerPod, WorkerResources, WorkerStatus
from services.k8s_client import load_incluster_once, run_sync
from services.k8s_resources import read_worker_resources
```

Then append the new route at the end of the file:

```python
@router.get("/resources", response_model=WorkerResources)
async def get_worker_resources() -> WorkerResources:
    """
    Return the worker pod CPU request (cores) and memory limit (MiB)
    by reading the live omb-worker StatefulSet spec.
    """
    cpu_cores, mem_mib = await read_worker_resources(settings.omb_namespace)
    return WorkerResources(cpu_request_cores=cpu_cores, memory_limit_mib=mem_mib)
```

- [ ] **Step 3: Verify the endpoint is registered**

```bash
cd control-plane && python -c "from routers.workers import router; print([r.path for r in router.routes])"
```

Expected output includes: `['/status', '/scale', '/resources']`

- [ ] **Step 4: Commit**

```bash
git add control-plane/schemas.py control-plane/routers/workers.py
git commit -m "feat: add GET /api/workers/resources endpoint"
```

---

## Task 5: Prometheus collector parameterization + launch_run wiring

**Files:**
- Modify: `control-plane/services/prometheus_collector.py:23-48`
- Modify: `control-plane/routers/runs.py:163-168`

- [ ] **Step 1: Update collect_prometheus signature in prometheus_collector.py**

Remove line 23:
```python
CPU_LIMIT_CORES = 4.0  # worker pods are always 4 vCPU per CLAUDE.md
```

Update the `_collect_sample` function signature (line 42) to accept `cpu_request_cores`:

```python
async def _collect_sample(
    client: httpx.AsyncClient,
    prom_url: str,
    namespace: str,
    run_id: int,
    t: int,
    cpu_request_cores: float,
) -> None:
```

Update the `cpu_pct` query inside `_collect_sample` to use the parameter instead of the removed constant:

```python
    cpu_pct = await _query(client, prom_url,
        f'100 * avg(rate(container_cpu_usage_seconds_total{{{worker_selector}}}[2m]))'
        f' / {cpu_request_cores}')
```

Update `collect_prometheus` signature to accept and forward the parameter:

```python
async def collect_prometheus(
    run_id: int,
    namespace: str,
    prom_url: str,
    cpu_request_cores: float = 4.0,
) -> None:
```

Update the `_collect_sample` call inside `collect_prometheus` to pass `cpu_request_cores`:

```python
        await _collect_sample(client, prom_url, namespace, run_id, t, cpu_request_cores)
```

Both calls to `_collect_sample` inside `collect_prometheus` need the argument — the immediate first sample (before the while loop) and the one inside the while loop.

- [ ] **Step 2: Wire cpu_request_cores into launch_run in runs.py**

In `control-plane/routers/runs.py`, add the import at the top of the file alongside existing imports:

```python
from services.k8s_resources import read_worker_resources
```

Update `launch_run()` (starting at line 163) to fetch resources and pass them:

```python
async def launch_run(
    run_id: int,
    driver_content: str,
    workload_content: str,
    *,
    await_finish: bool = False,
) -> None:
    """
    Start a k8s Job, kick off the Prometheus collector, and handle completion.

    await_finish=False (default): _finish_run runs as a background task so the
    caller returns immediately. Used by single runs via create_run.

    await_finish=True: _finish_run is awaited inline so the caller blocks until
    the run completes. Used by _execute_sweep to enforce sequential execution.

    Raises on runner.start() failure — callers mark the run failed and surface
    the error as appropriate for their context (HTTP 503 vs sweep continue).
    """
    await runner.start(run_id, driver_content, workload_content)
    prom_url = (
        f"http://omb-kube-prometheus-stack-prometheus"
        f".{settings.omb_namespace}.svc.cluster.local:9090"
    )
    cpu_request_cores, _ = await read_worker_resources(settings.omb_namespace)
    asyncio.create_task(
        collect_prometheus(run_id, settings.omb_namespace, prom_url, cpu_request_cores)
    )
    if await_finish:
        await _finish_run(run_id)
    else:
        asyncio.create_task(_finish_run(run_id))
```

- [ ] **Step 3: Verify imports parse cleanly**

```bash
cd control-plane && python -c "from routers.runs import launch_run; print('OK')"
```

Expected: `OK`

```bash
cd control-plane && python -c "from services.prometheus_collector import collect_prometheus; print('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add control-plane/services/prometheus_collector.py \
        control-plane/routers/runs.py
git commit -m "feat: parameterize prometheus collector CPU divisor from StatefulSet spec"
```

---

## Task 6: Frontend API function + RunDetailPage resource fetch

**Files:**
- Modify: `control-plane/frontend/src/api.js:20`
- Modify: `control-plane/frontend/src/pages/RunDetailPage.jsx`

- [ ] **Step 1: Add getWorkerResources to api.js**

In `control-plane/frontend/src/api.js`, add one line after the existing Workers section:

```js
// Workers
export const getWorkerStatus = () => request('GET', '/workers/status')
export const scaleWorkers = (replicas) => request('POST', '/workers/scale', { replicas })
export const getWorkerResources = () => request('GET', '/workers/resources')
```

- [ ] **Step 2: Add workerResources state to RunDetailPage**

In `control-plane/frontend/src/pages/RunDetailPage.jsx`, update the import on line 3:

```js
import { getRun, cancelRun, getPrometheusSamples, getSweepRuns, getSweep, getWorkerResources } from '../api.js'
```

Add the state variable alongside the other `useState` calls (after line 88, before `const wsRef`):

```js
const [workerResources, setWorkerResources] = useState(null)
```

- [ ] **Step 3: Add one-time fetch effect**

Add a new `useEffect` block after the existing `useEffect(() => { ... }, [id])` block (after line 167). This effect has an empty dependency array so it fires once on mount:

```js
  useEffect(() => {
    getWorkerResources().then(setWorkerResources).catch(() => {})
  }, [])
```

- [ ] **Step 4: Pass resource props to RunCharts**

In RunDetailPage, find the `<RunCharts` call (around line 441) and add the two new props:

```jsx
      <RunCharts
        livePoints={livePoints}
        metricsOut={run?.metrics ?? null}
        promSamples={promSamples}
        isLive={run?.status === 'running'}
        messageSize={messageSize}
        warmupSamples={warmupSamples}
        totalSamples={totalSamples}
        warmupStartedAt={warmupStartedAt}
        benchmarkStartedAt={benchmarkStartedAt}
        workerMemLimitMiB={workerResources?.memory_limit_mib ?? null}
        workerCpuCores={workerResources?.cpu_request_cores ?? null}
      />
```

- [ ] **Step 5: Commit**

```bash
git add control-plane/frontend/src/api.js \
        control-plane/frontend/src/pages/RunDetailPage.jsx
git commit -m "feat: fetch worker resources in RunDetailPage and pass to charts"
```

---

## Task 7: RunCharts dynamic memory bounds and CPU tooltip

**Files:**
- Modify: `control-plane/frontend/src/components/RunCharts.jsx`

- [ ] **Step 1: Add new props to RunCharts signature**

In `RunCharts.jsx`, update the function signature (line 78) to add the two new props with null defaults:

```jsx
export default function RunCharts({
  livePoints = [],
  metricsOut = null,
  promSamples = [],
  isLive = false,
  messageSize = 1024,
  warmupSamples = 60,
  totalSamples = 360,
  warmupStartedAt = null,
  benchmarkStartedAt = null,
  workerMemLimitMiB = null,
  workerCpuCores = null,
})
```

- [ ] **Step 2: Update the Worker CPU chart info tooltip**

Find the `<ChartCard title="Worker CPU (%)"` block (around line 291). Replace the hardcoded `info` string:

```jsx
          <ChartCard
            title="Worker CPU (%)"
            badge="worker"
            info={`CPU Usage: how much of the ${workerCpuCores != null ? workerCpuCores : 4}-core worker allocation the workers are consuming. Throttled: fraction of CPU scheduling slots the kernel rejected because the worker exceeded its cgroup quota. No CPU limit is set so throttle will always be 0 — any non-zero throttle value indicates a misconfiguration. High CPU usage means workers are busy — scale up worker count to increase throughput.`}
          >
```

- [ ] **Step 3: Update the Worker Memory chart**

Find the `<ChartCard title="Worker Memory (MiB)"` block (around line 306). The `YAxis`, `ReferenceLine`, and domain all need updating.

Replace the entire Worker Memory `ChartCard` content:

```jsx
          <ChartCard title="Worker Memory (MiB)" badge="worker">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={promPoints} syncId="run">
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="t" stroke={C.axis} tick={{ fill: C.axis, fontSize: 10 }} />
                <YAxis
                  stroke={C.axis}
                  tick={{ fill: C.axis, fontSize: 10 }}
                  width={55}
                  domain={[0, workerMemLimitMiB != null ? Math.ceil(workerMemLimitMiB * 1.1) : 9000]}
                />
                <Tooltip
                  contentStyle={{ background: '#171c28', border: '1px solid #2a3045', color: '#e8edf8', fontSize: 11 }}
                  formatter={(v, name) => [v != null ? `${v.toFixed(0)} MiB` : '—', name]}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: C.axis }} />
                <ReferenceLine
                  y={workerMemLimitMiB != null ? workerMemLimitMiB : 8192}
                  stroke="rgba(239,68,68,0.4)"
                  strokeDasharray="4 2"
                  label={{
                    value: workerMemLimitMiB != null
                      ? `${Math.round(workerMemLimitMiB / 1024)} GiB limit`
                      : '8 GiB limit',
                    fill: 'rgba(239,68,68,0.7)',
                    fontSize: 10,
                    position: 'insideTopRight',
                  }}
                />
                <Line type="monotone" dataKey="workerMemMiB" name="memory" stroke={C.workerMem} dot={false} strokeWidth={2} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
```

- [ ] **Step 4: Run the frontend tests to confirm nothing is broken**

```bash
cd control-plane/frontend && npm test
```

Expected: all existing tests pass. The RunCharts changes don't affect `chartDataUtils` or `ombLogParser` tests.

- [ ] **Step 5: Commit**

```bash
git add control-plane/frontend/src/components/RunCharts.jsx
git commit -m "feat: dynamic memory chart domain and reference line from worker resource props"
```

---

## Task 8: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the JVM heap design decision**

Find the paragraph starting with `**JVM heap is fixed in the Dockerfile entrypoint, not configurable.**` and replace it:

```markdown
**JVM heap is computed from container memory at startup, not hardcoded.** Worker pod
container memory is driven by `worker.resources.memory` in the Helm values. At pod start,
`-XX:MaxRAMPercentage=75.0` combined with `-XX:+UseContainerSupport` causes the JVM to
read its cgroup memory limit and set heap = 75% of that value automatically. Do not add
`-Xms`/`-Xmx` fixed heap flags — they would override the percentage and break dynamic
sizing. Do not expose JVM heap percentage as a Helm value — 75% is correct for all OMB
worker workloads.
```

- [ ] **Step 2: Update the worker resources standardization paragraph**

Find `**Worker pods are standardized at 4 vCPU / 8GB memory.**` (in the "Worker memory and JVM settings" section near the bottom). Replace the entire paragraph and JVM flags block:

```markdown
## Worker memory and JVM settings

Worker pod CPU and memory are set via `worker.resources.cpu` and `worker.resources.memory`
in the Helm values. Per-cloud defaults are in `values-aws.yaml`, `values-gcp.yaml`, and
`values-aks.yaml`. To use a different instance type, update the Terraform instance type and
these two Helm values — nothing else needs to change.

No CPU *limit* is set on worker pods (only a request). This prevents cgroup CPU throttling
architecturally. The memory limit equals the memory request.

Required JVM flags in the entrypoint script (do not add -Xms/-Xmx):
  -XX:InitialRAMPercentage=75.0
  -XX:MaxRAMPercentage=75.0
  -XX:+UseContainerSupport
  -XX:+UseG1GC
  -XX:MaxGCPauseMillis=10
  -XX:+ParallelRefProcEnabled
  -XX:+PerfDisableSharedMem
  -XX:+DisableExplicitGC

-XX:+UseContainerSupport causes the JVM to read cgroup memory limits. Combined with
MaxRAMPercentage=75.0 this produces heap = 75% of container memory automatically.
The correct response to needing more throughput is adding more worker pods via the UI
scaling control, not changing JVM settings or instance types.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for dynamic worker resource allocation"
```

---

## Verification

After all tasks are complete, verify end-to-end behavior in a live cluster:

- [ ] Run `helm upgrade omb charts/omb -n omb -f charts/omb/values-aws.yaml` and confirm worker pods restart with new resource values: `kubectl -n omb get pods -o jsonpath='{.items[*].spec.containers[0].resources}'`
- [ ] Confirm no CPU limit is set on worker pods: output should show `requests` but no `limits.cpu`
- [ ] Hit `GET /api/workers/resources` and confirm it returns the expected cpu/memory values
- [ ] Open a RunDetail page and confirm the memory chart reference line shows the correct GiB value (not hardcoded 8 GiB)
- [ ] Start a benchmark run and confirm the Prometheus memory chart domain tops out above the reference line with 10% headroom
