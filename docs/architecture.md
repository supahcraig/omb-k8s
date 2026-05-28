# OMB k8s Architecture Reference

This document is for engineers who need to debug, extend, or deeply understand the OMB
k8s system. It assumes familiarity with Kubernetes, Python, and Helm. For deployment
instructions see `docs/deployment-aws.md` (or `-gcp`, `-azure`). For UI navigation
see `CLAUDE.md`.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Worker Discovery Mechanism](#2-worker-discovery-mechanism)
3. [Benchmark Run Lifecycle](#3-benchmark-run-lifecycle)
4. [ConfigMap Pattern](#4-configmap-pattern)
5. [In-Cluster Kubernetes API Access](#5-in-cluster-kubernetes-api-access)
6. [SQLite on PersistentVolume](#6-sqlite-on-persistentvolume)
7. [Worker JVM Configuration](#7-worker-jvm-configuration)
8. [Node Pools and Scheduling](#8-node-pools-and-scheduling)
9. [Prometheus Metrics Collection](#9-prometheus-metrics-collection)
10. [Result Parsing](#10-result-parsing)
11. [Sweep Execution](#11-sweep-execution)
12. [VPC Peering Topology](#12-vpc-peering-topology)
13. [Image Entrypoint and OMB Runtime Quirks](#13-image-entrypoint-and-omb-runtime-quirks)
14. [Key Files Reference](#14-key-files-reference)

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  OMB k8s Cluster (EKS/GKE/AKS)  — namespace: omb               │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  control-plane pod (node-pool: control-plane)           │    │
│  │    FastAPI + React SPA (port 8000)                      │    │
│  │    SQLite on PersistentVolume (/data/omb_ui.db)         │    │
│  │    OMB benchmark binary (bin/benchmark, lib/)           │    │
│  │    ServiceAccount: omb-control-plane                    │    │
│  └──────────────────────────┬──────────────────────────────┘    │
│                             │ k8s API (in-cluster)              │
│                             │ (Jobs, ConfigMaps, StatefulSet,   │
│                             │  Pods, pod/log)                   │
│                             ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  k8s control plane (API server)                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  omb-worker StatefulSet (node-pool: worker)              │   │
│  │    omb-worker-0 (port 9080)  ←── headless Service        │   │
│  │    omb-worker-1 (port 9080)       "omb-worker"           │   │
│  │    omb-worker-N (port 9080)                              │   │
│  │    hostNetwork: true                                     │   │
│  │    dnsPolicy: ClusterFirstWithHostNet                    │   │
│  │    taint toleration: dedicated=benchmark:NoSchedule      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  driver Job (ephemeral, node-pool: control-plane)       │    │
│  │    init container: gen-payload (busybox)                │    │
│  │    main container: driver (worker image, OMB_MODE=driver│    │
│  │    mounts: ConfigMap + payload emptyDir                 │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌──────────────┐  ┌───────────────────────────────────────┐    │
│  │  Prometheus  │  │  Grafana                              │    │
│  │  port 9090   │  │  (kube-prometheus-stack subchart)     │    │
│  └──────────────┘  └───────────────────────────────────────┘    │
│                                                                   │
│  Cluster Autoscaler (control-plane pool, IRSA on AWS)            │
│  node-exporter DaemonSet (all nodes, taint-tolerating)           │
│                                                                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │ VPC Peering
                                │ routes: 9092-9093
┌───────────────────────────────▼─────────────────────────────────┐
│  Target Cluster (BYOC Redpanda or self-hosted Kafka)             │
│  Kafka protocol: ports 9092 (plain/SASL) and 9093 (TLS)         │
└─────────────────────────────────────────────────────────────────┘
```

**What it is:** A Helm-deployed benchmarking control plane that orchestrates OMB (OpenMessaging
Benchmark) workers as Kubernetes pods. The SE deploys it once per engagement, runs benchmarks
through the UI, then tears it down.

**What it is not:** A cluster provisioner. It benchmarks an *existing* Redpanda or Kafka cluster
over a VPC-peered network connection.

---

## 2. Worker Discovery Mechanism

### Why StatefulSet, not Deployment

Worker pods are a `StatefulSet` (not `Deployment`). This gives every pod a stable, predictable
ordinal DNS name via the headless Service named `omb-worker`:

```
omb-worker-0.omb-worker.<namespace>.svc.cluster.local:9080
omb-worker-1.omb-worker.<namespace>.svc.cluster.local:9080
omb-worker-N.omb-worker.<namespace>.svc.cluster.local:9080
```

The control plane never queries DNS or does service discovery. It constructs the `--workers`
argument by iterating `0..N-1` where `N` = current `spec.replicas` on the StatefulSet:

```python
# from services/omb_runner.py
workers_arg = ",".join(
    f"http://omb-worker-{i}.omb-worker.{namespace}.svc.cluster.local:{settings.omb_worker_port}"
    for i in range(replica_count)
)
```

This is queried fresh at Job creation time — the control plane calls
`apps_api.read_namespaced_stateful_set("omb-worker", namespace)` and reads
`sts.spec.replicas`.

### hostNetwork and DNS

Worker pods set `hostNetwork: true` to bypass CNI overhead for accurate benchmark results.
This causes a side effect: the default `dnsPolicy: ClusterFirst` no longer works — the pod
uses the host's DNS resolver, which does not know about cluster-internal names.

The fix is `dnsPolicy: ClusterFirstWithHostNet`. This restores cluster DNS while keeping
host networking active. **Do not remove this field** or workers will be unreachable by their
headless Service DNS names.

```yaml
# charts/omb/templates/worker/statefulset.yaml
spec:
  hostNetwork: true
  dnsPolicy: ClusterFirstWithHostNet
```

### Worker Health Probe

Before creating any ConfigMap or Job, `OmbRunner.start()` probes every worker concurrently
by sending `POST /stop-all` to each one:

- Healthy idle worker: returns HTTP 200
- Worker stuck from a prior cancelled run: returns HTTP 500

If any probe fails, `start()` raises a `RuntimeError` with the names of the failing workers.
This surfaces as HTTP 503 to the UI for single runs, or writes a failed run entry for sweep runs.

The Cluster page (`/cluster`) shows a health dot per worker pod and a restart button. Restarting
the pod (which deletes it; the StatefulSet controller recreates it immediately) clears any stuck
Java process state.

---

## 3. Benchmark Run Lifecycle

```
SE clicks Run
     │
     ▼
POST /api/runs
     │
     ├─ Write Run row to SQLite (status=running)
     │
     └─ launch_run(run_id, driver_content, workload_content)
              │
              ├─ OmbRunner.start()
              │       │
              │       ├─ Read StatefulSet replica count
              │       ├─ Probe all workers POST /stop-all (fail fast if any stuck)
              │       ├─ Create ConfigMap omb-run-{id} with driver.yaml + workload.yaml
              │       ├─ Parse messageSize from workload YAML
              │       ├─ Create k8s Job omb-run-{id}:
              │       │     init container: busybox dd /dev/urandom → /payload/payload.data
              │       │     main container: OMB_MODE=driver, mounts ConfigMap + payload
              │       │     args: --drivers /etc/omb/driver.yaml /etc/omb/workload.yaml
              │       │           --workers http://omb-worker-0..N:9080,...
              │       │           --output /tmp/omb-results
              │       └─ asyncio.create_task(_stream_logs)
              │
              ├─ asyncio.create_task(collect_prometheus)  ← non-blocking background task
              │
              └─ asyncio.create_task(_finish_run)  ← non-blocking background task
                       │
                       ├─ Polls runner.is_done() every 2 s (4-hour timeout)
                       ├─ On done: parse_result_from_logs(lines)
                       ├─ Write Metrics row + update Run status to completed/failed
                       └─ (ConfigMap deleted inside _stream_logs after pod exits)
```

### Concurrently

While the Job runs, two independent background tasks are in flight:

1. **`_stream_logs`** (started inside `OmbRunner.start()`): waits for the driver pod to appear,
   waits for it to reach Running/Succeeded/Failed phase, then streams logs line-by-line using
   `kubernetes.watch.Watch`. Each line is appended to `self._active[run_id]["lines"]` in real
   time. After the container exits, a non-follow read is done to catch any last lines missed by
   the streaming watch. Finally the ConfigMap is deleted.

2. **`collect_prometheus`** (started in `launch_run`): polls Prometheus every 15 s for cAdvisor
   worker metrics, writing `PrometheusSample` rows. Silently no-ops if Prometheus is unreachable.

### WebSocket log streaming

The UI subscribes to `/ws/runs/{run_id}`. The WebSocket handler polls
`runner.get_lines(run_id)` to send buffered lines to the client as they arrive. This is
a polling-over-WebSocket approach, not a push model — the WS handler sends all accumulated
lines on each tick, then waits a short interval before the next tick.

### Cancellation

`DELETE /api/runs/{run_id}` calls `runner.stop(run_id)`, which calls
`batch_api.delete_namespaced_job(job_name, ..., propagation_policy="Foreground")`. This
deletes the Job and all its pods. The run status is set to `cancelled`.

---

## 4. ConfigMap Pattern

ConfigMaps are **ephemeral** — they are created at Job start and deleted after the Job exits.

| Field | Value |
|-------|-------|
| Name | `omb-run-{run_id}` |
| Keys | `driver.yaml`, `workload.yaml` |
| Lifetime | Created before Job, deleted in `_stream_logs` post-exit |
| Source | Raw YAML text from SQLite `runs.driver_config` / `runs.workload_config` |

The ConfigMap is mounted into the driver container at `/etc/omb/`:

```
/etc/omb/driver.yaml      ← from ConfigMap key driver.yaml
/etc/omb/workload.yaml    ← from ConfigMap key workload.yaml
```

### OMB YAML quirks

Two fields must always be present to avoid NPEs in the OMB Java code:

1. **`--output /tmp/omb-results`**: OMB calls `new File(output)` unconditionally before null
   checks. The value is a throwaway path — results are parsed from stdout, not this file.

2. **`topicConfig: ""`**: `Config.topicConfig` has no Java default. If absent, `new StringReader(null)`
   NPEs at driver init. When specifying actual topic config, use Java Properties format
   (`key=value` on each line), not YAML key/value syntax.

3. **`payloadFile`**: OMB calls `new File(payloadFile)` unconditionally and enforces exact byte count.
   The init container generates `/payload/payload.data` with exactly `messageSize` bytes via
   `dd if=/dev/urandom bs={messageSize} count=1`. The emptyDir volume is shared between the
   init container and the driver container.

---

## 5. In-Cluster Kubernetes API Access

The control plane uses the Python `kubernetes` client with `config.load_incluster_config()`.
Credentials are injected automatically by Kubernetes at:
```
/var/run/secrets/kubernetes.io/serviceaccount/token
/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
```

No `kubeconfig` files are mounted or used.

### ServiceAccount and Role

| Resource | Name | Namespace |
|----------|------|-----------|
| ServiceAccount | `omb-control-plane` | `omb` |
| Role | `omb-control-plane` | `omb` |
| RoleBinding | `omb-control-plane` | `omb` |

Role permissions (`charts/omb/templates/rbac/role.yaml`):

```yaml
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "delete", "get", "list", "watch"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["create", "delete", "get", "list"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create", "get", "update"]
  - apiGroups: ["apps"]
    resources: ["statefulsets"]
    verbs: ["get", "patch", "update"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch", "delete"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get", "list", "watch"]
```

The `secrets` permission is for storing the Prometheus scrape config secret (created by the
chart at install time). The `pods` delete permission is used by the Cluster page restart
functionality.

### Synchronous k8s client in async FastAPI

The `kubernetes` Python client is **synchronous**. FastAPI is async. All k8s API calls go
through `run_sync()` in `services/k8s_client.py`, which runs the synchronous call in a
thread pool executor via `asyncio.get_event_loop().run_in_executor()`. This prevents the
synchronous calls from blocking the async event loop.

### Long-running background tasks

`_finish_run` polls for up to 4 hours. It must be launched with `asyncio.create_task()`,
**not** FastAPI's `BackgroundTasks`. FastAPI's `BackgroundTasks` runs tasks sequentially —
if `_finish_run` were registered as a `BackgroundTask`, no subsequent background tasks would
start until it returned.

---

## 6. SQLite on PersistentVolume

### File location

```
Pod path:  /data/omb_ui.db
PVC name:  omb-control-plane-data
```

The path is `/data/omb_ui.db` — not `/data/omb.db`.

### Storage classes by cloud

| Cloud | StorageClass | Notes |
|-------|-------------|-------|
| AWS | `gp3` | Created by the Helm chart (`templates/storageclass-gp3.yaml`); requires `aws-ebs-csi-driver` addon |
| GCP | `standard` (pd-ssd) | Use cloud default |
| Azure | `managed-premium` | Use cloud default |

The gp3 StorageClass is only created if `storage.createStorageClass: true` (set in
`values-aws.yaml`). The `aws-ebs-csi-driver` EKS addon is provisioned by the Terraform
EKS module — without it, the StorageClass exists but PVC provisioning fails silently.

### Survival characteristics

| Event | SQLite survives? |
|-------|-----------------|
| Control-plane pod restart | Yes — PVC persists |
| Helm upgrade | Yes — PVC not touched |
| `helm uninstall` | PVC is NOT auto-deleted (workloads gone, data may still exist on disk) |
| `kubectl delete pvc omb-control-plane-data` | No |

### Schema

Managed by SQLAlchemy's `Base.metadata.create_all()` plus manual `ALTER TABLE` statements
in `database.init_db()` for additive column migrations on existing deployments.

Tables:

| Table | Purpose |
|-------|---------|
| `runs` | One row per benchmark run. Stores status, driver/workload YAML snapshots, sweep linkage, timestamps, error message. |
| `metrics` | One row per completed run. Aggregated and per-percentile latency and throughput values. |
| `prometheus_samples` | One row per 15-second poll interval per run. Stores aggregate and per-pod CPU/memory. |
| `sweeps` | One row per parameter sweep. Stores axes, cooldown, status, timestamps. |
| `workloads` | Saved workload configs (bundled + user-saved). |
| `settings` | Key/value store. Currently holds cluster connectivity (seed brokers, TLS, SASL) and Prometheus settings. |

### ORM and async engine

```python
# database.py
engine = create_async_engine(
    f"sqlite+aiosqlite:///{settings.omb_db_path}",
    ...
)
```

The engine uses `aiosqlite` for async SQLite access. `PRAGMA foreign_keys=ON` is set on
every connection via a `connect` event listener.

---

## 7. Worker JVM Configuration

### Entrypoint design

The worker Dockerfile entrypoint (`worker/entrypoint.sh`) calls `java` **directly** using
`-cp lib/*`, not via the upstream `bin/benchmark-worker` script. This is intentional: the
upstream script hardcodes `HEAP_OPTS="-Xms4G -Xmx8G"` and appends its own GC flags, which
would silently override the flags below.

The entrypoint dispatches on `$OMB_MODE`:
- `worker`: starts `io.openmessaging.benchmark.worker.BenchmarkWorker --port 9080`
- `driver`: `exec`s `io.openmessaging.benchmark.Benchmark "$@"` (passes all Job args through)

### JVM flags

```bash
JVM_OPTS="\
-XX:InitialRAMPercentage=75.0 \
-XX:MaxRAMPercentage=75.0 \
-XX:+UseContainerSupport \
-XX:+UseG1GC \
-XX:MaxGCPauseMillis=10 \
-XX:+ParallelRefProcEnabled \
-XX:+PerfDisableSharedMem \
-XX:+DisableExplicitGC \
-XX:MinHeapFreeRatio=10 \
-XX:MaxHeapFreeRatio=20"
```

| Flag | Effect |
|------|--------|
| `UseContainerSupport` | JVM reads cgroup memory limit rather than host memory (JDK 11+ default, explicit here for clarity) |
| `InitialRAMPercentage=75.0` / `MaxRAMPercentage=75.0` | Heap = 75% of container memory request, computed automatically at startup. Do not add `-Xms`/`-Xmx` — they would override this. |
| `UseG1GC` | G1 garbage collector, tuned for low pause |
| `MaxGCPauseMillis=10` | Target max GC pause of 10 ms |
| `ParallelRefProcEnabled` | Parallel reference processing to reduce GC pause |
| `PerfDisableSharedMem` | Prevents GC pauses from shared memory operations (important on benchmark workloads) |
| `DisableExplicitGC` | Ignores `System.gc()` calls from within OMB |
| `MinHeapFreeRatio=10` / `MaxHeapFreeRatio=20` | G1GC shrinks committed heap back toward live set after a run completes, so worker memory charts show actual usage rather than the high-water mark from a prior run |

### Worker pod resources

```yaml
resources:
  requests:
    cpu: "15"        # values-aws.yaml (m5.4xlarge has 16 vCPU; leave 1 for system)
    memory: "58Gi"   # values-aws.yaml (m5.4xlarge has 64 GB; leave headroom)
  limits:
    memory: "58Gi"   # memory limit = request (no CPU limit — prevents throttling)
```

No CPU *limit* is set on worker pods. This is architectural — it prevents cgroup CPU
throttling. The memory limit equals the request so the JVM's cgroup memory detection
returns a deterministic value.

Scaling for more throughput means adding more worker pods via the UI, not changing
instance types or JVM settings.

---

## 8. Node Pools and Scheduling

The cluster is split into two node pools with strict scheduling isolation.

### Pool definitions

| Pool | Label | Taint | Workloads |
|------|-------|-------|-----------|
| `control-plane` | `node-pool: control-plane` | None | control-plane pod, Prometheus, Grafana, Cluster Autoscaler, driver Jobs |
| `worker` | `node-pool: worker` | `dedicated=benchmark:NoSchedule` | omb-worker StatefulSet pods only |

### Instance types

| Cloud | Control-plane pool | Benchmark-worker pool |
|-------|-------------------|-----------------------|
| AWS | m5.xlarge, fixed 2 nodes | m5.4xlarge, 0–20 nodes |
| GCP | n2-standard-4, fixed 2 nodes | n2-standard-16, 0–20 nodes |
| Azure | Standard_D4s_v3, fixed 2 nodes | Standard_D16s_v3, 0–20 nodes |

4xlarge-class instances are chosen because they provide dedicated network interfaces,
eliminating noisy-neighbor network contention. Each such node comfortably holds ~8 worker pods
before the Cluster Autoscaler adds another node.

### Scheduling enforcement

Worker StatefulSet carries:
```yaml
nodeSelector:
  node-pool: worker
tolerations:
  - key: dedicated
    operator: Equal
    value: benchmark
    effect: NoSchedule
```

All other workloads carry only:
```yaml
nodeSelector:
  node-pool: control-plane
```

The `NoSchedule` taint on worker nodes prevents any pod without a matching toleration from
landing there.

**Exception:** `node-exporter` is a DaemonSet that runs on all nodes. It carries a toleration
for the worker taint so it can collect host-level metrics from benchmark nodes:
```yaml
# values.yaml (kube-prometheus-stack section)
prometheus-node-exporter:
  tolerations:
    - key: dedicated
      operator: Equal
      value: benchmark
      effect: NoSchedule
```

### Worker pod anti-affinity

Worker pods have a `requiredDuringSchedulingIgnoredDuringExecution` pod anti-affinity rule
on `kubernetes.io/hostname`. This spreads workers across nodes (one per node), which is
required for `hostNetwork: true` — two pods on the same host would both try to bind port 9080.

### Cluster Autoscaler (AWS)

The Cluster Autoscaler runs on the control-plane pool and is wired to scale the benchmark-worker
node group. On AWS it uses IRSA (IAM Roles for Service Accounts):

1. EKS Terraform module creates an OIDC provider and IAM role
2. Role ARN is output as `cluster_autoscaler_iam_role_arn`
3. Helm install must pass `--set clusterAutoscaler.roleArn=<arn>`

Without the role ARN, the Cluster Autoscaler deploys but cannot call the EC2 Auto Scaling API.

---

## 9. Prometheus Metrics Collection

### Architecture

`services/prometheus_collector.py` runs as a background `asyncio` task alongside each
benchmark run. It queries the in-cluster `kube-prometheus-stack` Prometheus instance at:

```
http://omb-kube-prometheus-stack-prometheus.<namespace>.svc.cluster.local:9090
```

This URL is hardcoded in `routers/runs.py:launch_run()` (not from the settings table).

### Queries

Every 15 seconds, four PromQL instant queries are issued:

| Metric | Query pattern | Storage column |
|--------|--------------|----------------|
| Aggregate CPU % | `100 * avg(rate(container_cpu_usage_seconds_total[2m])) / {cpu_request_cores}` | `worker_cpu_pct` |
| Aggregate memory MiB | `avg(container_memory_working_set_bytes) / 1048576` | `worker_memory_mib` |
| Throttle % | `100 * max(rate(throttled_periods) / rate(total_periods))` | `worker_throttle_pct` |
| Per-pod memory | Same memory query without avg, keyed by `pod` label | `worker_memory_per_pod` (JSON) |
| Per-pod CPU % | Same CPU query without avg, keyed by `pod` label | `worker_cpu_per_pod` (JSON) |

Per-pod columns store JSON objects: `{"omb-worker-0": 42.1, "omb-worker-1": 38.7, ...}`.

The `worker_selector` targets only `omb-worker-*` pods in the container named `worker`:
```
namespace="<ns>",pod=~"omb-worker-.*",container="worker"
```

### Graceful degradation

The collector silently no-ops if Prometheus is unreachable. Any query error is logged at
DEBUG level and returns `None`/`{}`. A missing Prometheus deployment never breaks a benchmark
run — the UI charts simply show no worker resource data for that run.

---

## 10. Result Parsing

Results are parsed from Job log lines in `services/result_parser.py` using two strategies:

**Strategy 1:** Look for a bare JSON line containing `publishRate` (future-proof, handles
OMB versions that write results to stdout as JSON).

**Strategy 2 (primary):** Parse the OMB stdout format — per-second stat lines and the final
aggregate summary line:

```
# Per-second line (during run):
Pub rate 12345 msg/s / 11.77 MB/s | Cons rate 12341 msg/s | Backlog: 0.0 K | ...

# Aggregate summary (once at end, warmup excluded):
----- Aggregated Pub Latency (ms) avg: 1.23 - 50%: 1.10 - 95%: 2.10 - 99%: 3.45 - 99.9%: 5.67 - 99.99%: 8.90 - Max: 15.0
```

The aggregate summary line is a reliable signal of clean OMB completion — it only appears when
the benchmark finishes normally. Its presence is used as the criterion for marking a run
`completed` vs `failed`, regardless of Job exit code.

Results are stored in the `metrics` table. The `throughput_timeseries` and `backlog_timeseries`
columns store the per-second lists as JSON for chart rendering in the UI.

---

## 11. Sweep Execution

A sweep is a cartesian product over parameter axes, run sequentially with a configurable
cooldown between runs.

### Axes

Two independent sets of axes:
- **Workload axes**: override YAML scalar fields in `workload_content` (e.g. `messageSize`, `producerRate`)
- **Driver axes**: override YAML scalar fields in `driver_content` (e.g. `producerConfig.acks`)

Special handling in `_apply_params` (`routers/sweeps.py`): `producerConfig`, `consumerConfig`,
and `topicConfig` fields are Java Properties strings (not YAML maps). Dot-notation overrides like
`producerConfig.acks` are applied as `key=value` lines within the existing string, not as nested
YAML keys. Nesting them as YAML would cause a `MismatchedInputException` at OMB driver init.

### Execution flow

```
POST /api/sweeps
     │
     ├─ Create Sweep row
     ├─ Compute cartesian product of all axes
     ├─ Create N Run rows (status=pending)
     └─ asyncio.create_task(_execute_sweep(sweep_id, run_ids, contents))
              │
              For each run (sequentially):
              ├─ Set run status = running
              ├─ launch_run(run_id, ..., await_finish=True)
              │     ← await_finish=True blocks until the run completes
              └─ Sleep cooldown_seconds before next run
```

`launch_run(await_finish=True)` awaits `_finish_run` inline rather than spawning it as a
background task. This is what enforces sequential execution — the next run does not start
until the current one is fully parsed and stored.

---

## 12. VPC Peering Topology

Workers need to reach broker ports 9092–9093 on the target cluster. The target cluster is in
a separate VPC (or VNet). VPC peering bridges them.

### AWS

```
OMB VPC (SE-owned account)
      ↕  aws_vpc_peering_connection (auto_accept = true)
Target VPC (same SE-owned account — BYOC uses the SE's account)
```

- Both VPCs are in the same account, so `auto_accept = true` works without a separate accepter resource.
- Route tables are discovered automatically via `data "aws_route_tables"` — no manual input of route table IDs.
- Optional: `target_security_group_id` variable adds an inbound rule to the broker SG allowing
  the OMB VPC CIDR on ports 9092–9093. Without it, routes work but broker connections are blocked
  at the SG layer.

Terraform module: `terraform/modules/peering/aws/`

### GCP and Azure

Two-sided peering — both directions must be configured in Terraform because neither cloud
auto-accepts. The peering modules are independent and separately runnable:

```
terraform/modules/peering/
  aws/     — standalone, independently runnable
  gcp/     — standalone, independently runnable
  azure/   — standalone, independently runnable
```

These are three separate modules, not a single module with a `cloud` variable. Terraform
cannot conditionally initialize providers, so a unified module would require all three cloud
providers regardless of which cloud is active.

### Terraform state

State is local (`terraform.tfstate`). No remote backend. The SE is responsible for keeping
their local state until `terraform destroy` completes.

---

## 13. Image Entrypoint and OMB Runtime Quirks

### Image contents

The worker image is based on the OMB distribution but strips all driver JARs except:
- `driver-kafka` — Kafka protocol driver
- `driver-redpanda` — Redpanda-specific driver
- `driver-api` — Required interface implemented by both (not optional)

All other drivers (Pulsar, RabbitMQ, Pravega, etc.) are removed to keep the image small.

### Dual-mode image

The same image serves as both worker and driver:

```bash
case "${OMB_MODE:-worker}" in
  worker)
    java ... io.openmessaging.benchmark.worker.BenchmarkWorker --port 9080 &
    ;;
  driver)
    exec java ... io.openmessaging.benchmark.Benchmark "$@"
    ;;
esac
```

Worker pods in the StatefulSet set `OMB_MODE=worker`. Driver containers in the k8s Job set
`OMB_MODE=driver`. The driver container receives all benchmark args from the Job spec.

### SIGTERM handling

The worker entrypoint traps `SIGTERM` and forwards it to the child Java process. This is
required for graceful Kubernetes pod termination — without it, the pod receives SIGTERM,
the shell exits, and the Java process is orphaned then hard-killed, potentially leaving
the worker in a corrupt state.

---

## 14. Key Files Reference

| File | Purpose |
|------|---------|
| `control-plane/main.py` | FastAPI app factory, lifespan (DB init + workload seeding), router mounting, SPA fallback |
| `control-plane/config.py` | Pydantic settings: `OMB_DB_PATH`, `OMB_NAMESPACE`, `OMB_WORKER_PORT`, `WORKER_IMAGE` |
| `control-plane/models.py` | SQLAlchemy ORM: `Run`, `Metrics`, `PrometheusSample`, `Sweep`, `Workload`, `Setting` |
| `control-plane/database.py` | Async SQLite engine, `init_db()` with additive migrations |
| `control-plane/routers/runs.py` | `POST /api/runs`, `launch_run()`, `_finish_run()` background task |
| `control-plane/routers/sweeps.py` | `POST /api/sweeps`, `_execute_sweep()`, `_apply_params()` |
| `control-plane/routers/cluster.py` | `GET /api/cluster/pods`, worker health probe, pod restart |
| `control-plane/routers/ws.py` | WebSocket `/ws/runs/{run_id}` — polls `runner.get_lines()` |
| `control-plane/services/omb_runner.py` | `OmbRunner` singleton — creates/monitors k8s Jobs, streams logs, worker probes |
| `control-plane/services/prometheus_collector.py` | Polls Prometheus every 15 s, writes `PrometheusSample` rows |
| `control-plane/services/result_parser.py` | Parses OMB log output into metrics dict |
| `control-plane/services/k8s_client.py` | `load_incluster_once()`, `run_sync()` thread-pool wrapper |
| `control-plane/services/k8s_resources.py` | Reads worker CPU/memory requests from StatefulSet spec |
| `worker/entrypoint.sh` | Dual-mode entrypoint: worker or driver, fixed JVM flags, SIGTERM forwarding |
| `worker/Dockerfile` | OMB distribution, driver JAR filtering, entrypoint installation |
| `charts/omb/values.yaml` | Base Helm values (images, replicas, port, storage, Prometheus toggle) |
| `charts/omb/values-aws.yaml` | AWS overrides: gp3 StorageClass, Cluster Autoscaler, worker resource sizes |
| `charts/omb/values-gcp.yaml` | GCP overrides: StorageClass, worker resource sizes |
| `charts/omb/values-aks.yaml` | Azure overrides: StorageClass, worker resource sizes |
| `charts/omb/templates/rbac/role.yaml` | RBAC Role with exact k8s API permissions |
| `charts/omb/templates/worker/statefulset.yaml` | Worker StatefulSet: hostNetwork, dnsPolicy, anti-affinity, taint toleration |
| `charts/omb/templates/control-plane/deployment.yaml` | Control-plane Deployment: SA, env vars, PVC mount |
| `charts/omb/templates/control-plane/pvc.yaml` | PVC for SQLite: `omb-control-plane-data` |
| `terraform/aws/` | EKS cluster, node groups, VPC, OIDC, IRSA, EBS CSI driver addon |
| `terraform/gcp/` | GKE Standard cluster, node pools, VPC |
| `terraform/azure/` | AKS cluster, node pools, VNet |
| `terraform/modules/peering/{aws,gcp,azure}/` | Standalone VPC peering modules, one per cloud |
