# Dynamic Worker Resource Allocation

**Date:** 2026-05-26
**Status:** Draft

## Problem

Worker pods are hardcoded to 4 vCPU / 8 GiB memory, but the benchmark worker node pool
uses m5.4xlarge (16 vCPU / 64 GiB). This wastes 75% of each node. The JVM heap is also
hardcoded at 4 GiB, which is 50% of the container and 6% of the node. When an SE uses a
different instance type, they must manually update six places across Terraform, Docker,
Helm, Python, and React — most of which they don't know about.

The goal is to reduce an instance-type change to two steps: update the Terraform instance
type and update two Helm values. Everything downstream (JVM heap, Prometheus CPU %, memory
chart reference line) must self-configure from those two values with no further changes.

## Design

### Single source of truth: Helm values

`worker.resources.cpu` and `worker.resources.memory` in values.yaml become the authoritative
declaration of what each worker pod gets. Per-cloud values files set these to near-full node
capacity for the default instance type. The SE overrides them in their own values file when
using a non-default instance type.

The StatefulSet template reads these values. Every downstream system reads from the live
StatefulSet spec, not from a second copy of the same numbers.

### No CPU limits — requests only

The StatefulSet sets a CPU *request* but no CPU *limit*. Without a limit, the kernel's CFS
quota is never set, so cgroup CPU throttling is architecturally impossible. The existing
throttle-% chart and warning banner remain as belt-and-suspenders monitors but will always
show zero when workers have room to run.

Setting only a request (no limit) is the correct k8s pattern for latency-sensitive benchmark
workloads. The request tells the scheduler which nodes to consider; the absence of a limit
means the pod can use any spare CPU on the node freely.

The memory limit remains (equal to the request) to enforce an OOM boundary.

### JVM heap: percentage flags, not fixed values

`-Xms4G -Xmx4G` are replaced with:

```
-XX:InitialRAMPercentage=75.0
-XX:MaxRAMPercentage=75.0
```

Combined with the existing `-XX:+UseContainerSupport`, the JVM reads the container's cgroup
memory limit at startup and computes heap = 75% of that value. No bash arithmetic, no
Downward API injection, no image rebuild when resource values change via `helm upgrade`.

**Why 75%?** JVM off-heap (thread stacks, JIT compiled code, class metadata, native memory)
runs 1–4 GiB for OMB worker workloads regardless of machine size. 75% of 8 GiB = 6 GiB heap,
leaving 2 GiB off-heap. 75% of 60 GiB = 45 GiB heap, leaving 15 GiB off-heap — ample even
for large-scale runs. OMB workers are not heavy direct-buffer users so the headroom is safe.

### Dynamic resource API endpoint

A new `GET /api/workers/resources` endpoint reads the live omb-worker StatefulSet spec and
returns the container's CPU request (in cores) and memory limit (in MiB). This is the single
runtime source of truth consumed by both the Prometheus collector and the frontend charts.

The existing RBAC Role already grants `get` on StatefulSets — no permission changes needed.

**Response shape:**
```json
{ "cpu_request_cores": 15.0, "memory_limit_mib": 61440 }
```

Kubernetes resource strings (`"15"`, `"60Gi"`) are parsed to floats/ints by the endpoint.
If the StatefulSet is unreachable the endpoint returns a 503; callers handle this gracefully
(collector uses a fallback, chart renders without the reference line).

### Prometheus collector: parameterized divisor

`CPU_LIMIT_CORES = 4.0` is removed. The `collect_prometheus()` function gains a
`cpu_request_cores: float` parameter. The resource fetch and pass-through happen inside
`launch_run()` in `runs.py`, not in the route handler, because `launch_run` is shared by
both single runs (`create_run` route) and sweeps (`routers/sweeps.py` calls it directly).
Placing the fetch in `launch_run` means both paths benefit with one change.

The CPU % formula stays the same:
```
100 * avg(rate(container_cpu_usage_seconds_total[2m])) / cpu_request_cores
```

With `cpu_request_cores` reflecting the full node allocation, the metric reads as "% of
worker CPU allocation in use." Values above 100% are possible (burst above request when the
node has spare capacity) and are a useful signal.

If `GET /api/workers/resources` fails before the collection task starts, `runs.py` falls back
to `cpu_request_cores = 4.0` (the previous hardcoded value) and logs a warning. The run
proceeds normally; CPU % will be scaled to 4 cores rather than the actual allocation, which
is a known degraded-mode limitation rather than a silent error.

The throttle % query is unchanged. With no CPU limit, `container_cpu_cfs_throttled_periods_total`
stays at zero permanently — the metric exists but the rate is 0, so `throttle_pct` returns 0.

### Frontend: dynamic chart bounds

`RunDetailPage` fetches `GET /api/workers/resources` on mount and passes the result to
`RunCharts` as `workerMemLimitMiB` and `workerCpuCores` props.

`RunCharts` changes:
- Memory chart `domain`: `[0, Math.ceil(workerMemLimitMiB * 1.1)]` — 10% headroom above
  the limit so the reference line is never flush with the top of the chart. Falls back to
  `[0, 9000]` if the prop is absent.
- Memory chart `ReferenceLine`: `y={workerMemLimitMiB}`, label updated to show the actual
  value (e.g., "60 GiB limit"). Falls back to `y={8192}` if absent.
- CPU chart info tooltip: replaces hardcoded "4-core limit" with the actual core count.

## Per-cloud default sizing

| Cloud | Instance | vCPU | RAM | `worker.resources.cpu` | `worker.resources.memory` | JVM heap (~75%) |
|-------|----------|------|-----|------------------------|---------------------------|-----------------|
| AWS   | m5.4xlarge | 16 | 64 GiB | `"15"` | `"58Gi"` | ~43 GiB |
| GCP   | n2-standard-16 | 16 | 64 GiB | `"15"` | `"58Gi"` | ~43 GiB |
| Azure | Standard_D16s_v3 | 16 | 64 GiB | `"15"` | `"58Gi"` | ~43 GiB |

CPU request is set to 15 (not 16) to leave 1 vCPU for kubelet, node-exporter, and OS
scheduling. Memory headroom accounts for kubelet system reserved and the node-exporter
DaemonSet (~32 MiB).

**Switching to a different instance type (e.g., m5.8xlarge — 32 vCPU / 128 GiB):**
1. `terraform/aws/eks.tf`: change `instance_type` to `m5.8xlarge`, run `terraform apply`
2. SE's values file (or `values-aws.yaml`): set `worker.resources.cpu: "31"` and
   `worker.resources.memory: "120Gi"`, run `helm upgrade`

No other changes required.

## Data flow

```
terraform/aws/eks.tf          → node pool instance type (SE changes this)
charts/omb/values-aws.yaml    → worker.resources.cpu / .memory (SE changes this)
         │
         ▼
StatefulSet spec              → container resources (cpu request, memory limit)
         │
         ├──▶ entrypoint.sh + UseContainerSupport
         │         └──▶ JVM reads cgroup limit → heap = 75% (automatic)
         │
         ├──▶ GET /api/workers/resources
         │         ├──▶ collect_prometheus(cpu_request_cores=...) → CPU % divisor
         │         └──▶ RunCharts(workerMemLimitMiB=..., workerCpuCores=...)
         │                   ├──▶ memory chart domain + reference line
         │                   └──▶ CPU chart tooltip text
         │
         └──▶ (throttle metric always 0 — no CPU limit set)
```

## File inventory

| File | Change |
|------|--------|
| `worker/entrypoint.sh` | Replace `-Xms4G -Xmx4G` with `InitialRAMPercentage=75.0` / `MaxRAMPercentage=75.0` |
| `charts/omb/templates/worker/statefulset.yaml` | Use `{{ .Values.worker.resources.* }}`; CPU request only (no limit); memory request = limit |
| `charts/omb/values.yaml` | Add `worker.resources.cpu: "4"` and `worker.resources.memory: "8Gi"` as conservative fallback defaults |
| `charts/omb/values-aws.yaml` | Add `worker.resources.cpu: "15"` and `worker.resources.memory: "58Gi"` (file currently only has `storage.storageClassName`) |
| `charts/omb/values-gcp.yaml` | Add `worker.resources.cpu: "15"` and `worker.resources.memory: "58Gi"` (file currently only has `storage.storageClassName`) |
| `charts/omb/values-aks.yaml` | Add `worker.resources.cpu: "15"` and `worker.resources.memory: "58Gi"` (file currently only has `storage.storageClassName`) |
| `control-plane/schemas.py` | Add `WorkerResources` response schema: `{ cpu_request_cores: float, memory_limit_mib: int }` |
| `control-plane/routers/workers.py` | Add `GET /api/workers/resources` endpoint returning `WorkerResources` |
| `control-plane/services/prometheus_collector.py` | Remove `CPU_LIMIT_CORES = 4.0`; add `cpu_request_cores: float` param to `collect_prometheus()` |
| `control-plane/routers/runs.py` | Inside `launch_run()`: fetch worker resources from k8s, pass `cpu_request_cores` to `collect_prometheus`. Covers both single-run and sweep paths since both call `launch_run`. |
| `control-plane/frontend/src/api.js` | Add `getWorkerResources()` calling `GET /api/workers/resources` |
| `control-plane/frontend/src/pages/RunDetailPage.jsx` | Fetch `getWorkerResources()` on mount; pass result as props to `RunCharts` |
| `control-plane/frontend/src/components/RunCharts.jsx` | Accept `workerMemLimitMiB` / `workerCpuCores` props; dynamic domain, reference line, tooltip text |
| `CLAUDE.md` | Update "4 vCPU / 8GB" references; update JVM flags list to reflect percentage-based flags |

## Out of scope

- Making JVM heap percentage configurable as a Helm value — 75% is correct for all OMB
  worker workloads; exposing it adds complexity with no practical benefit
- Vertical pod autoscaling — scaling is horizontal (more pods), not vertical
- Automatic instance type detection from the node — requires node label inspection and
  a lookup table; not worth the complexity when two Helm values suffice
- Control-plane pool sizing — those pods are not performance-critical and their resources
  are fine as-is
