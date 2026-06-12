# omb-k8s

A cloud-native benchmarking platform for Redpanda and Kafka-compatible clusters
using the OpenMessaging Benchmark (OMB) framework. This replaces an existing
Terraform + Ansible approach that is difficult to maintain across multiple clouds
and requires destructive operations to scale workers.

## What this is

A Helm-deployable system that runs OMB workers as scalable k8s pods, orchestrated
by a control plane UI. An SE deploys it once per customer engagement, runs
benchmarks iteratively through the UI, then tears it down. The thing being
benchmarked (the Redpanda or Kafka cluster) is always external — this tool never
provisions the target cluster.

## What this is NOT

- A cluster provisioning tool — it benchmarks existing clusters only
- A long-term results persistence system — results are engagement-scoped
- A generic messaging benchmark tool — Kafka protocol only, Redpanda-specific workloads
- A fully automated CI/CD benchmark pipeline — SEs run this interactively

## Architecture

```
┌─────────────────────────────────────────────┐
│  OMB k8s Cluster (EKS/GKE/AKS)             │
│                                             │
│  control-plane pod                          │
│    FastAPI + React                          │
│    SQLite on PersistentVolume               │
│    OMB benchmark binary (for driver Jobs)   │
│                                             │
│  omb-worker pods (StatefulSet, N replicas)  │
│    Pure OMB worker, port 9080               │
│    Scales non-destructively                 │
│                                             │
│  prometheus + grafana pods                  │
│                                             │
└──────────────────┬──────────────────────────┘
                   │ VPC Peering
┌──────────────────▼──────────────────────────┐
│  Target Cluster (BYOC or self-hosted)       │
│  Redpanda or Kafka-compatible               │
└─────────────────────────────────────────────┘
```

## Repo structure

```
/
  charts/omb/              Helm chart
  control-plane/           FastAPI + React control plane
  worker/                  OMB worker Dockerfile
  terraform/
    aws/
    gcp/
    azure/
    modules/
      peering/
        aws/               Standalone AWS VPC peering module
        gcp/               Standalone GCP VPC peering module
        azure/             Standalone Azure VNet peering module
  .github/
    workflows/
      build-worker.yml
      build-control-plane.yml
  claude/                  Extended reference docs for Claude Code sessions
  docs/
  CLAUDE.md
  README.md
```

## Key design decisions — do not reverse these without discussion

**Workers are a StatefulSet, not a Deployment.** This gives pods stable,
predictable DNS names (omb-worker-0.omb-worker:9080, omb-worker-1.omb-worker:9080,
etc.) via a headless Service. This is how the control plane constructs the
--workers argument dynamically without a service registry or Ansible inventory.

**Worker list is derived from replica count at Job creation time.** The control
plane knows how many worker pods exist because it manages the StatefulSet. It
constructs the --workers argument by iterating 0..N-1. No self-registration, no
service discovery, no static config.

**YAML configs are stored as text in SQLite, not as files on disk.** At Job
creation time the control plane renders driver and workload YAML from DB records
into a k8s ConfigMap. The Job mounts the ConfigMap. Nothing benchmark-related
lives on disk permanently except the SQLite file itself on the PV.

**Sweep storage is three-level.** The `sweeps` table stores `parameter_axes` —
a JSON object of every axis and its full value list (both workload and driver axes
merged). Each `runs` row stores `sweep_params` (the specific parameter values
for that iteration) and the full resolved `driver_config` + `workload_config`
YAMLs with those values applied. Do not store only workload axes in
`parameter_axes` — driver axes must be included or the sweep definition is
incomplete.

**SQLite on a PersistentVolume, not Postgres.** Results are engagement-scoped.
SQLite is sufficient, requires zero migration from the existing codebase, and
survives pod restarts via the PV. Do not introduce Postgres.

**JVM heap is computed from container memory at startup, not hardcoded.** Worker pod
container memory is driven by `worker.resources.memory` in the Helm values. At pod start,
`-XX:MaxRAMPercentage=75.0` combined with `-XX:+UseContainerSupport` causes the JVM to
read its cgroup memory limit and set heap = 75% of that value automatically. Do not add
`-Xms`/`-Xmx` fixed heap flags — they would override the percentage and break dynamic
sizing. Do not expose JVM heap percentage as a Helm value — 75% is correct for all OMB
worker workloads.

**The entrypoint calls java directly, not bin/benchmark-worker.** The upstream
bin/benchmark-worker script hardcodes HEAP_OPTS="-Xms4G -Xmx8G" and appends its
own GC flags, which would silently override the fixed JVM flags above. The
entrypoint invokes java directly with -cp lib/* to keep the specified flags
authoritative. Do not refactor the entrypoint to delegate to the bin scripts.

**Only driver-kafka, driver-redpanda, and driver-api JARs are included in the
worker image.** The OMB distribution bundles JARs for every driver (Pulsar,
RabbitMQ, Pravega, etc.). The Dockerfile strips all driver JARs except these
three. driver-api is the required interface that driver-kafka and driver-redpanda
both implement — it is not optional.

**hostNetwork: true on worker pods.** Bypasses CNI overhead for accurate benchmark
results. The control plane does not use hostNetwork.

**k8s API calls use in-cluster service account credentials.** The control plane
pod has a ServiceAccount with a Role that permits: create/delete Jobs,
create/delete ConfigMaps, get/update StatefulSets, get/delete Pods. Do not mount
or reference external kubeconfig files.

**Cloud differences are isolated in per-cloud values files.** The Helm chart is
cloud-agnostic. values-aws.yaml, values-gcp.yaml, values-aks.yaml contain only
what differs (StorageClass names, node pool sizing, etc.).

**Images are published to ghcr.io.** Not Docker Hub. Not a cloud-native registry.
GitHub Container Registry keeps everything in one place and has no pull rate limits.

**Terraform state is local.** No remote state backend for Phase 1. SE is
responsible for not deleting their local state until after terraform destroy.
Document this clearly.

**EKS Kubernetes version is not hardcoded.** The `aws_eks_cluster` resource omits
the `version` argument so new clusters always get the latest AWS-supported version.
Do not add a hardcoded version — this caused a production failure when 1.29 AMIs
were retired. If version pinning is ever needed, make it a variable with no default.

**Peering module is three independent sub-modules, not one.** `terraform/modules/peering/`
contains `aws/`, `gcp/`, and `azure/` sub-directories, each independently runnable.
A single module with a `cloud` variable was considered but rejected because Terraform
cannot conditionally initialize providers — all configured providers must be present
regardless of which cloud is active. Do not collapse these into a single module.

**VPC peering uses `auto_accept = true`.** Both the OMB VPC and the Redpanda BYOC VPC
live in the same AWS account (the SE's account), so the peering connection can be
auto-accepted. Do not add a manual acceptance step or `aws_vpc_peering_connection_accepter`
resource — they are not needed for this use case.

**VPC peering route tables are discovered at plan time, not provided in tfvars.** The
`data "aws_route_tables"` data source looks up all route table IDs for a given VPC ID.
Routes are added to all route tables on both sides automatically. Do not reintroduce a
`source_route_table_ids` or `target_route_table_ids` variable — requiring SEs to look up
and manually enter route table IDs is unnecessary toil.

**Redpanda broker security group ID cannot be auto-discovered.** The optional
`target_security_group_id` variable (default "") accepts the SG ID attached to Redpanda
broker nodes. When set, Terraform adds an inbound rule allowing the OMB VPC CIDR on
ports 9092-9093. If omitted, routes work but broker connections will be refused at the SG
layer. This is a known gap — see project memory for the revisit plan.

**EKS Cluster Autoscaler uses IRSA.** The EKS module creates an OIDC provider and
an IAM role for the Cluster Autoscaler via IAM Roles for Service Accounts (IRSA).
The role ARN is exposed as the `cluster_autoscaler_iam_role_arn` output and must
be passed to the Helm chart via `clusterAutoscaler.roleArn`. The Helm chart will
not deploy the Cluster Autoscaler correctly without it.

**EKS node group uses a launch template to attach the OMB workers security group.**
EKS managed node groups don't support attaching additional security groups directly.
The workaround is a launch template that specifies both the cluster-managed security
group (`vpc_config[0].cluster_security_group_id`) and the OMB workers SG (port 9080).
Do not remove the launch template or the node group will lose the port 9080 rules.

**EKS requires the EBS CSI driver addon for PVC provisioning.** The default EKS
setup only has the in-tree `kubernetes.io/aws-ebs` provisioner, which creates a
`gp2` StorageClass. The Helm chart uses `gp3` (cheaper, faster), which requires
the `aws-ebs-csi-driver` EKS addon. The addon is provisioned by the EKS Terraform
module via `aws_eks_addon` with an IRSA role (`ebs-csi-controller-sa` in
`kube-system`). The `gp3` StorageClass itself is created by the Helm chart
(`templates/storageclass-gp3.yaml`), gated on `storage.createStorageClass: true`
in `values-aws.yaml`. Do not remove either — without the addon the StorageClass
exists but PVC provisioning fails; without the StorageClass the PVC stays Pending.

**Worker pods require `dnsPolicy: ClusterFirstWithHostNet`.** When `hostNetwork: true`
is set, the default `dnsPolicy` of `ClusterFirst` breaks — the pod uses the host's
DNS instead of the cluster DNS, so `omb-worker-0.omb-worker.<ns>.svc.cluster.local`
does not resolve. Setting `dnsPolicy: ClusterFirstWithHostNet` restores cluster DNS
while keeping host networking. Do not remove this field.

**The cluster is split into two node pools: control-plane and benchmark-worker.**
The control-plane pool runs everything except omb-worker pods: control-plane app,
Prometheus, Grafana, Cluster Autoscaler, and driver Jobs. The benchmark-worker pool
runs only omb-worker pods. Pool sizes:

| Cloud | Control-plane pool | Benchmark-worker pool |
|-------|-------------------|----------------------|
| AWS   | m5.xlarge, fixed 2 | m5.4xlarge, 0–20 |
| GCP   | n2-standard-4, fixed 2 | n2-standard-16, 0–20 |
| Azure | Standard_D4s_v3, fixed 2 | Standard_D16s_v3, 0–20 |

Nodes are labeled `node-pool: control-plane` or `node-pool: worker`. Worker nodes
carry a `dedicated=benchmark:NoSchedule` taint so non-worker pods cannot land on
them without an explicit toleration. Every Helm workload has a matching `nodeSelector`.
The worker StatefulSet also has a `tolerations` entry for the benchmark taint.
node-exporter is a DaemonSet that runs on all nodes and carries a toleration for
the worker taint so it can collect host metrics from benchmark nodes.
Driver Jobs run on the control-plane pool — they orchestrate the benchmark but do
not execute it. Resource requests for driver Jobs: 500m CPU / 512Mi memory.

**Azure AKS note:** Renaming `default_node_pool` from `workers` to `controlplane`
forces destruction and recreation of the entire AKS cluster. Re-deploy fresh;
do not attempt in-place upgrade of an existing AKS engagement cluster.

**GKE uses Standard mode, not Autopilot.** `hostNetwork: true` on worker pods
requires Standard mode — Autopilot does not permit hostNetwork. Do not change
`remove_default_node_pool = true` / `initial_node_count = 1` pattern; this is the
correct way to use a separately managed node pool with Standard GKE clusters.

**Cluster provisioning is out of scope.** If you find yourself writing code that
creates Redpanda broker nodes or interacts with the Redpanda Cloud API, stop.

**Cluster names are auto-generated via `random_pet` if not specified.** Each cloud's
Terraform module declares `resource "random_pet" "cluster_suffix" { length = 2 }`.
`var.cluster_name` defaults to `""`. A `locals` block resolves the effective name:
`var.cluster_name != "" ? var.cluster_name : "omb-${random_pet.cluster_suffix.id}"`.
All resource names reference `local.cluster_name`, not `var.cluster_name`. The suffix
is stable across re-applies because Terraform persists it in state. To use a custom
name, set `cluster_name` in terraform.tfvars. Do not reintroduce a required
`cluster_name` variable — name collisions across SEs sharing an AWS account were
the motivation for this change.

**The control-plane LoadBalancer is restricted to `controlPlane.allowedCIDRs`.** The
Helm chart sets `spec.loadBalancerSourceRanges` on the control-plane Service from this
value. Default is `["0.0.0.0/0"]` (open). Each Terraform module outputs
`terraform_operator_ip` (the public IP detected via icanhazip.com at plan time) so the
SE can restrict access at deploy time:
`helm install omb ... --set "controlPlane.allowedCIDRs[0]=$(terraform output -raw terraform_operator_ip)/32"`.
To add IPs post-deploy without redeploying the cluster: `helm upgrade omb charts/omb -n omb
--reuse-values --set "controlPlane.allowedCIDRs[0]=<ip1>/32"`. `loadBalancerSourceRanges`
is honored by AWS (ELB SG rules), GCP (VPC firewall rules), and AKS (NSG rules).

**Long-running background tasks must use `asyncio.create_task()`, not FastAPI `BackgroundTasks`.**
FastAPI's `BackgroundTasks` awaits each task sequentially. `_finish_run` polls for
the entire benchmark duration (up to 4 hours), so if it is registered as a
`BackgroundTask`, any task registered after it will never start until the run
finishes. Do not change this back to `background_tasks.add_task()`.

**`launch_run()` in `routers/runs.py` is the single entry point for starting any run.**
It calls `runner.start()`, fires `collect_prometheus` as a non-blocking background
task, then either fires `_finish_run` as a background task (`await_finish=False`,
used by single runs) or awaits it inline (`await_finish=True`, used by sweeps for
sequential execution). Both `create_run` and `_execute_sweep` call `launch_run` —
do not duplicate the three-step sequence elsewhere.

**Concurrent runs each get a dedicated worker pool.** `create_run` returns
immediately with `status="pending"` and launches pool provisioning in
`asyncio.create_task(_bg_launch(...))`. When a run starts and another is already
active, `services/worker_pool_manager.py::claim_pool()` creates a new StatefulSet
(`omb-worker-pool-{uuid}`) and headless Service by cloning the default worker
spec. Once all replicas are ready, the run transitions to `status="running"`.
If no other run is active, the pre-existing `omb-worker` default pool is used
(no new StatefulSet created). Do not return a blocking HTTP response from
`create_run` — pool provisioning can take up to 10 minutes on a cold node and the
browser will time out and retry, creating duplicate runs.

**Worker pool lifecycle: provisioning → in_use → ready → deleted.** All pool
state transitions use Core-style `db.execute(update(...).values(...))`, never
ORM attribute mutation followed by `db.expunge()`. The expunge pattern silently
drops attribute changes before commit. `claim_pool` returns a fresh `WorkerPool`
object (not the ORM instance) after every Core-style update.

**Warm pool reclaim before provisioning.** When a new run starts while a concurrent
pool is in `ready` (warm retention) state, `claim_pool` reclaims that pool instead
of provisioning a new EC2 node. `cancel_teardown(pool_id)` cancels the pending
asyncio teardown task. This avoids ~10-minute node cold-start delays when runs
arrive in close succession.

**`warm_until` tracks when warm retention expires.** Set by `_finish_run` when a
concurrent pool transitions to `ready`. The Cluster page reads this value and shows
a live M:SS countdown in the Worker Pools table. Default pool never gets
`warm_until` (it is never torn down). Concurrent pools with `warm_until = NULL`
were either set to `ready` manually or predate the feature — their teardown was
never scheduled; release them manually from the Cluster page.

**Pool teardown task registry.** `worker_pool_manager.py` maintains a module-level
`dict[str, asyncio.Task]` mapping `pool_id → pending teardown task`. Control-plane
pod restarts kill all in-flight asyncio tasks, leaving any `in_use` pool stuck.
Manual fix: `UPDATE worker_pools SET status='ready', claimed_by_run_id=NULL WHERE
status='in_use'` — then release via the Cluster page or let the next run reclaim
them.

**`concurrent_pool_retention_minutes` in Settings → Benchmark Behavior.** Controls
how long concurrent pools stay warm after a run completes (default 30 min). Set to
0 for "Manual only" — pool stays alive until explicitly released. Stored in the
`settings` table under key `benchmark_behavior`.

## Target clouds

- AWS — primary (~80% of usage)
- GCP — secondary (~18%)
- Azure — minimal (~2%)
- OCI — future, not in scope now

## Target cluster types

**BYOC (Redpanda Cloud):**
- Single bootstrap server
- TLS required
- SASL/SCRAM-SHA-256 required

**Self-hosted:**
- Multiple seed brokers (comma-separated)
- TLS optional
- SASL optional (SCRAM-SHA-256, SCRAM-SHA-512, PLAIN)

## How a benchmark run works

1. SE opens UI, selects or creates a workload config
2. Control plane stores driver + workload YAML as text in SQLite
3. SE clicks Run — HTTP returns immediately with `status="pending"`; pool provisioning
   runs in a background task. If another run is active, a new worker pool StatefulSet
   is provisioned; otherwise the default `omb-worker` pool is claimed.
4. Once the pool is ready, control plane transitions run to `status="running"` and
   writes driver + workload YAML into a k8s ConfigMap
5. Control plane creates a k8s Job with:
   - An init container (busybox) that creates `/data/results/` on the PVC and
     generates `/payload/payload.data` with exactly `messageSize` random bytes
     via `dd if=/dev/urandom`
   - The driver container mounting the ConfigMap, the payload emptyDir, and the
     control-plane data PVC (`omb-control-plane-data`) at `/data`:
     bin/benchmark --drivers /etc/omb/driver.yaml /etc/omb/workload.yaml \
       --workers http://omb-worker-0.omb-worker:9080,... --output /data/results/run-{id}
   - A `podAffinity` rule that forces the Job pod onto the same node as the
     control-plane pod (required for the ReadWriteOnce EBS PVC to be mountable
     by both pods simultaneously)
6. UI streams Job logs via websocket
7. Concurrently, `services/prometheus_collector.py` polls the in-cluster
   kube-prometheus-stack Prometheus every 15 s for cAdvisor worker metrics and
   writes them to `prometheus_samples`. Each sample row stores aggregate averages
   (`worker_cpu_pct`, `worker_memory_mib`, `worker_throttle_pct`) and per-pod JSON
   objects (`worker_memory_per_pod`, `worker_cpu_per_pod`, `worker_net_tx_per_pod`,
   `worker_net_drop_per_pod`) keyed by pod name. Network queries use a `net_selector`
   without `container="worker"` because `container_network_*` metrics are pod-level
   in cAdvisor (no container label). The Prometheus service is at:
   `http://omb-kube-prometheus-stack-prometheus.{namespace}.svc.cluster.local:9090`
   The collector silently no-ops if Prometheus is unreachable.
8. On completion, `_finish_run` reads `/data/results/run-{id}` from the PVC
   (high-fidelity JSON with full per-second arrays), falls back to log parsing
   if the file is absent, stores metrics in SQLite, then renames the result file
   to `run-{id}.json` (standalone run) or `sweep-{sweep_id}-run-{id}.json`
   (sweep run). Files persist on the PVC for later analysis.

## OMB runtime quirks — do not remove these workarounds

**`--output` is required.** This OMB build calls `new File(output)` unconditionally
in `WorkloadGenerator.run()` before checking for null. Omitting `--output` causes
an immediate NPE. The output is written to `/data/results/run-{id}` on the
control-plane PVC. `_finish_run` reads this file for high-fidelity results (full
per-second arrays), falls back to log parsing if absent, then renames the file to
`run-{id}.json` or `sweep-{sweep_id}-run-{id}.json`. Files are inspectable via
`kubectl exec -n omb <control-plane-pod> -- ls /data/results/` and copyable to
local with `kubectl cp -n omb <control-plane-pod>:/data/results/run-{id}.json ./run-{id}.json`.
Do not change
`--output` back to `/tmp` — that path is ephemeral and inaccessible after the
container exits.

**`topicConfig: ""` is required in driver YAML.** `Config.topicConfig` has no Java
default value. If absent from the driver YAML, Jackson leaves it null and
`new StringReader(null)` NPEs at driver init. Always emit `topicConfig: ""`.
When setting actual topic config values, use Java Properties format (`key=value`),
not YAML syntax (`key: value`). Example: `topicConfig: "retention.ms=600000"`.
Using YAML key-value syntax causes a Jackson `MismatchedInputException`.

**`payloadFile` must always be set and point to a file with exactly `messageSize`
bytes.** This OMB build calls `new File(payloadFile)` unconditionally and then
enforces an exact byte-count match. The init container generates the file at
`/payload/payload.data` so any arbitrary `messageSize` works. Do not remove the
init container or change the path without understanding this constraint.

**Worker pods can get stuck after a cancelled run.** When a run is cancelled
mid-flight, the OMB worker's internal Java process may be left in an error state.
`OmbRunner.start()` probes every worker via `POST /stop-all` before creating the
ConfigMap or Job. A healthy idle worker returns 200; a stuck worker returns 500.
If any worker fails the probe, `start()` raises a `RuntimeError` with a clear
message naming the worker, which surfaces as an HTTP 503 to the UI for single runs
or a failed run entry for sweeps. The Cluster tab shows a red health dot on
unreachable workers and provides a ↺ restart button on every pod row. Restarting
the worker pod clears the state; the StatefulSet controller recreates it
immediately.

**`producerConfig`, `consumerConfig`, and `topicConfig` in driver YAML must remain
Java Properties strings, not YAML objects.** Jackson deserializes these fields as
`String`, not `Map`. If sweep parameter overrides (e.g. `producerConfig.acks`)
are applied by converting them to YAML nested keys, Jackson throws
`MismatchedInputException` at driver init. `_apply_params` in `routers/sweeps.py`
special-cases these three fields: dot-separated keys like `producerConfig.acks`
are parsed as `key=value` property lines within the existing string value rather
than being set as nested YAML keys. Do not change this to YAML nesting.

**SASL password is stored plaintext in SQLite.** Encryption was removed because
the password ends up in a k8s ConfigMap anyway — encryption provided no real
security benefit and caused runs to break silently after pod restarts due to
ephemeral key rotation. The settings API returns `sasl_password` in GET responses
so `DriverForm` can embed it directly in the generated YAML.

**Settings page has no BYOC/self-hosted distinction.** The cluster connectivity tab
is a single unified form — seed broker chips, TLS toggle, SASL toggle + mechanism.
BYOC and self-hosted both work identically once TLS and SASL are configured; the
distinction was removed as unnecessary complexity. The Prometheus tab accepts either
comma-separated `scrape_targets` (self-hosted, e.g. `broker:9644`) or a full
Prometheus scrape job YAML (`scrape_yaml`, for BYOC with basic_auth). At run start,
`_load_broker_targets()` in `routers/runs.py` reads whichever is configured and fires
`probe_broker_prometheus()` as a background task — this GETs `/metrics` from each
target and logs a sample of metric names for diagnostics. No broker metrics are stored
or displayed yet; chart integration is a future phase.

**`sampleRateMillis` defaults to 1000 ms in WorkloadForm.** OMB's own default is
10 000 ms (one stat line every 10 s). The UI default overrides this to 1000 ms
(one stat line per second) for better live chart resolution. The final aggregated
stats (p50/p99/etc.) come from a cumulative histogram and are unaffected by this
value. Do not revert to 10 000 — SEs can increase it manually for very long runs
where log volume is a concern.

## Who uses this

Redpanda Solutions Engineers running customer benchmarks. They are comfortable
with Helm and k8s basics. They are not k8s experts. The UI is their primary
interface during an engagement — they should not need kubectl for day-to-day
operations after initial deployment.

## Deployment workflow

1. Clone repo to local machine
2. cd terraform/<cloud> && cp terraform.tfvars.example terraform.tfvars and fill in values (terraform.tfvars is gitignored)
3. export KUBECONFIG=$(pwd)/terraform/<cloud>/kubeconfig (isolates this cluster's config from ~/.kube/config; set before get-credentials)
4. terraform init && terraform apply (provisions k8s cluster + VPC + peering)
5. aws/gcloud/az eks/gke/aks get-credentials (configure local kubectl; writes to $KUBECONFIG path)
6. helm repo add prometheus-community https://prometheus-community.github.io/helm-charts && helm repo update (one-time per machine; required before dependency build)
7. helm dependency build charts/omb (downloads kube-prometheus-stack and other chart deps into charts/omb/charts/; safe to re-run)
8. On AWS: `terraform output -raw helm_install_command | bash` — this runs the pre-filled helm install command with all CA and CIDR values substituted. On GCP/Azure: `helm install omb charts/omb -n omb -f charts/omb/values-<cloud>.yaml --set "controlPlane.allowedCIDRs[0]=$(terraform output -raw terraform_operator_ip)/32"`
6. Open the UI at the LoadBalancer address
7. Configure cluster connectivity and Prometheus in Settings
8. Run benchmarks
9. helm uninstall omb && terraform destroy when engagement is complete

## CI/CD — image builds

Both `.github/workflows/build-control-plane.yml` and `.github/workflows/build-worker.yml` trigger automatically on `push: branches: [main]`. Pushing to main is sufficient — do not manually trigger `gh workflow run` for main branch deploys.

To test a feature branch before merging, use:
```bash
gh workflow run build-control-plane.yml --repo supahcraig/omb-k8s --ref <branch-name>
```

Images are tagged with the full git SHA (`github.sha`) and also `latest`. To deploy a new image after a push to main:
```bash
# Get the SHA that was pushed
git rev-parse main

# Roll out the new image
kubectl -n omb set image deployment/omb-control-plane \
  control-plane=ghcr.io/supahcraig/omb-control-plane:<sha>
kubectl -n omb rollout status deployment/omb-control-plane

# Or simply restart to pull :latest (if already on latest tag)
kubectl -n omb rollout restart deployment/omb-control-plane
```

## Current environment

- **Cloud:** AWS (EKS)
- **Kubernetes namespace:** `omb`
- Use `kubectl -n omb` for all kubectl commands in this project.
- Use `helm install omb charts/omb -n omb ...` when deploying.

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
  -XX:MinHeapFreeRatio=10
  -XX:MaxHeapFreeRatio=20

-XX:+UseContainerSupport causes the JVM to read cgroup memory limits. Combined with
MaxRAMPercentage=75.0 this produces heap = 75% of container memory automatically.
MinHeapFreeRatio=10 / MaxHeapFreeRatio=20 causes G1GC to shrink the committed heap
back toward the live set after a large run completes, so worker memory charts reflect
actual usage rather than the high-water mark from a prior run.
The correct response to needing more throughput is adding more worker pods via the UI
scaling control, not changing JVM settings or instance types.

## UI navigation structure

The frontend is a React SPA served by FastAPI. A sticky left sidebar (220px)
handles all navigation. Routes and pages:

| Route | Page | Purpose |
|-------|------|---------|
| `/` | RunsPage | Results-only list of completed and active runs |
| `/runs/new` | NewRunPage | Configure and launch a run or sweep; prefills from last run on mount |
| `/runs/:id` | RunDetailPage | Live log streaming, real-time charts, final metrics; sweep nav bar when run belongs to a sweep |
| `/sweeps` | SweepsPage | Parameter sweep list; rows clickable; columns: name, status, run count, Best Pub P99, Best E2E P99 |
| `/sweeps/new` | NewSweepPage | Redirects to `/runs/new` with `state={{ enableSweep: true }}` |
| `/sweeps/:id` | SweepDetailPage | Sweep overview — sortable run comparison table; rows clickable; two-row sticky super-header groups sweep parameter columns; checkbox-driven percentile curve charts + heatmap (capped at 10 runs); Grafana link above table |
| `/workloads` | WorkloadLibraryPage | Workload and driver library — two tabs (Workloads / Drivers); full CRUD for custom entries; bundled entries are read-only |
| `/settings` | SettingsPage | Cluster connectivity (seed brokers, TLS, SASL) + Prometheus scrape targets + Benchmark Behavior (pool retention) |
| `/cluster` | ClusterPage | k8s cluster status, worker health, pod restart; Worker Pools table with idle countdown and Release button |
| `/timeline` | TimelinePage | SVG Gantt chart of all runs; zoom/scroll with 1-hour default window; bars colored by phase |

Sidebar nav groups:
- **Main:** Benchmark Runs → (sub) + New Run / Sweeps / Workload Library / Timeline
- **Infrastructure** (below divider): OMB Cluster / Settings
- **Bottom:** Worker scaling control (label + readiness badge + input + Scale button)

## Key frontend design decisions — do not reverse without discussion

**DriverForm and WorkloadForm never own YAML display.** Both components are
pure form inputs — they call `onChange` with the built YAML string whenever a
field changes. The parent page (NewRunPage) holds `driverYaml`/`workloadYaml`
state and renders the YAML textareas itself. Do not add a YAML preview or
override/lock mechanism back into these components — it was removed because
`isOverride = true` caused all fields to lock on re-open.

**New Run and Benchmark Runs are separate pages.** `/runs/new` (NewRunPage) is
the form; `/` (RunsPage) is the results list. They were split because having
the form toggle on the results page created confusing UX. WorkloadLibrary
navigates to `/runs/new` with `location.state` to prefill the workload.

**New Run and New Sweep share a single page at `/runs/new`.** `NewRunPage` has a
pill toggle switch that enables the Parameter Sweep section. When the toggle is
off, submit creates a single run. When on and at least one axis has values, submit
creates a sweep. The sweep section sits above the driver/workload panels and
auto-expands when localStorage contains saved axes with values. `/sweeps/new` is
kept as a redirect to `/runs/new?state={enableSweep:true}` for backward
compatibility (bookmarks). Do not add a separate sweep form page.

**Parameter Sweep axes are split into Driver (left) and Workload (right) panels.**
Each panel has its own field dropdown (from a fixed list + "Custom…" escape hatch)
and chip inputs. There is no per-row type dropdown. Axes are stored separately in
localStorage as `workloadAxes` and `driverAxes`. The old format (single `axes`
array with a `type` field) is migrated on first read. The sweep section defaults to
disabled on page load regardless of saved axes — it only auto-enables when navigating
from `/sweeps/new`. Individual axes can be deleted down to zero per panel.

**Launching a run or sweep navigates immediately to the execution page.**
`NewRunPage` navigates to `/runs/:id` after `createRun` returns, or fetches
`getSweepRuns(sweep.id)` after `createSweep` and navigates to the first run's
`/runs/:id` (or `/sweeps/:id` if no runs exist yet).

**`RunDetailPage` shows a sweep nav bar when the run belongs to a sweep.**
If `run.sweep_id` is set, the page fetches sibling runs via `getSweepRuns` and
renders a horizontal pill strip above the page header. Each pill shows the sweep
parameter values for that run (e.g. `acks=0`) and uses CSS glow animations to
reflect live state: running pills glow green, the pending run in cooldown glows
ice blue, failed pills are red with no glow. Each pill computes its cooling state
independently from `prevRun.completed_at + sweep.cooldown_seconds` vs `Date.now()`
— do NOT use the shared `cooldownRemaining` state for this, it is only valid for
the currently viewed run. Pills poll every 3 s while any sibling is still running
or pending. When the current run transitions out of `running` AND the WebSocket
signaled completion (`wsSignaledDoneRef`), the page auto-advances to the next
sibling run. `wsSignaledDoneRef` is only set when `wsHasDataRef` is true — this
guards against a race where `is_done()` returns true for unregistered run IDs,
which would otherwise trigger false auto-advance when viewing a pending run that
just transitioned to running. Do not add per-run detail logic to `SweepDetailPage`
— it is a comparison table only; `RunDetailPage` is the shared execution view for
both single runs and sweep runs.

**Sweep nav chips stay visible during same-sweep navigation.** The reset effect
(`useEffect([id])`) deliberately does NOT clear `run`, `sweepRuns`, or `sweep`
state, so chips remain rendered while the new run loads. A stale-run guard in the
WS effect (`if (run.id !== Number(id)) return`) prevents the old run's WebSocket
from opening. `sweepRuns`/`sweep` are cleared only when `run.sweep_id` goes
falsy (user leaves the sweep entirely).

**`activeRunIdRef` prevents stale async callbacks from contaminating navigation.**
Every `loadRun` and `pollUntilFinished` call captures `expectedId = Number(id)`
at call time and checks `activeRunIdRef.current !== expectedId` after every
`await`. The reset effect sets `activeRunIdRef.current = Number(id)` before
calling `loadRun`. This prevents the WebSocket `onclose` handler of a prior run
from calling `setRun` on the new run's page, which was the root cause of
auto-advance misfires when navigating between sweep runs.

**`RunDetailPage` shows a cooldown countdown between sweep runs.** When the
current run is completed and the next run is pending, or when the current run is
pending and the previous run just completed, a 🧊 countdown badge appears in the
sweep nav bar. The timer is anchored to `run.completed_at + sweep.cooldown_seconds`
from the server, so it is accurate after navigation. SQLite stores naive UTC
datetimes without 'Z'; always append 'Z' before `new Date(ts)` in JavaScript to
avoid local-timezone misinterpretation.

**RunCharts renders per-worker CPU, memory, and network series.** The Worker CPU,
Worker Memory, and Worker Network Tx charts each show one `<Line>` per pod using
the `worker_cpu_per_pod` / `worker_memory_per_pod` / `worker_net_tx_per_pod` JSON
columns from `prometheus_samples`. If CPU/memory columns are absent (old runs), those
charts fall back to the averaged `workerCpuPct` / `workerMemMiB` columns. The Worker
Network Tx chart is only rendered when `worker_net_tx_per_pod` data is present
(`hasNetworkMetrics`); the worker row is 3-column when network data exists, 2-column
otherwise. Network Tx stores raw bytes/sec; `tickFormatter` and tooltip `formatter`
divide by 1_048_576 to display MB/s. Memory y-axis is in GiB (data stays in MiB;
`tickFormatter` divides by 1024). An amber alert banner fires when any pod has nonzero
`worker_net_drop_per_pod` values, listing each affected pod and its peak drops/sec.
Pod list for all worker charts is derived from `workerMem_*` keys (`workerPods`). All
chart x-axes show local time; SQLite datetimes always need `+Z` appended before
`new Date()` to parse as UTC correctly.

**RunCharts does not show latency charts.** Per-second log-emitted latency stats
(rolling window P99) cannot be reconciled with the cumulative HDR P99 in
FinalizedCharts, so they were removed to avoid confusion. Latency is owned
entirely by FinalizedCharts post-completion. Live HDR latency during a run is
planned — see `claude/hdr-live-latency.md`.

**RunCharts expected-rate reference lines.** `RunDetailPage` computes `expectedMsgSec`
and `expectedMBSec` from `workload_config.producerRate` and `messageSize`, and
`expectedConsMsgSec`/`expectedConsMBSec` by multiplying by `subscriptionsPerTopic`.
These are passed as props to `RunCharts` which renders amber dashed `ReferenceLine`
components on the Throughput (msg/s) and Throughput (MB/s) charts. A green dashed
consume reference line is added only when consume rate differs from publish rate
(i.e. `subscriptionsPerTopic > 1`). The y-axis domain is `[0, niceMax(max(dataMax,
expectedRate))]` — `niceMax` adds 15% headroom and rounds to half-magnitude steps
so the axis stays snug while still showing reference lines when target > actual.

**RunCharts CPU saturation alert.** An amber alert banner fires when any worker's CPU
exceeds 85% of its CPU request (uses per-pod `workerCpu_*` keys, falls back to the
aggregate `workerCpuPct`). A dashed amber reference line at 85% and a solid red line
at 100% mark the chart. The 85% threshold is intentional — without a CPU limit,
cgroup throttling never fires; resource exhaustion instead degrades throughput silently.

**Backlog chart is clamped to ≥ 0.** `normalizeTimeseries` applies `Math.max(0, v)`
to stored backlog values. `RunCharts` applies the same clamp inline when building
`chartPoints` from `livePoints`, since livePoints arrive raw from the WebSocket parser
and bypass `normalizeTimeseries`.

**RunDetailPage post-completion view shows finalized HDR charts.** When a run
completes, the page switches to a finalized view: (1) 2-column throughput tiles
(publish rate + consume rate, actual vs target) sized to content (`inline-grid`);
(2) `FinalizedCharts` component with the nines table, HDR percentile curves
(nines-transformed log x-axis), and latency histograms — all badged `omb`;
(3) `RunCharts` showing throughput/backlog/worker charts from stored metrics.
The Run Log auto-collapses on completion and has a `▶`/`▼` twisty indicator.
`FinalizedCharts` no longer shows a per-second latency time series — those stats
are not reconcilable with the cumulative HDR P99. `FinalizedCharts` receives
`results` from `GET /api/runs/{id}/results` (polled with retries after completion).
HDR results are also stored in the `run_results` SQLite table by
`parse_and_store_hdr_results` (triggered async from `_finish_run`). `MetricCard`
accepts an `expected` prop; if actual < 95% of expected the value renders red,
≥ 95% renders green. All charts and tiles carry a source badge (`omb`, `redpanda`,
or `worker`) identifying the data origin.

**Timeline page (`/timeline`) is a zoomable SVG Gantt chart of all runs.** Fetches
`GET /api/runs/timeline`. The default view window is `now − 1 hour` to `now + 1 min`.
Bars are colored by phase (gray = initializing, blue = warmup, green = benchmark).
In-progress bars extend to "now" with a pulse animation. Sweep runs are indented under
their sweep with a shared left border. Click any bar navigates to `/runs/:id`. Scroll
wheel zooms centered on mouse X; click-drag pans. Preset buttons: 1h, 3h, 6h, All.
No new library dependency — pure SVG with `clipPath` to clip bars at view boundaries.

**Cluster page shows image digest per pod.** The `/api/cluster/pods` endpoint extracts
`container_statuses[0].image_id` and parses the sha256 digest (first 12 chars) as
`image_hash`. Falls back to `image_ref` (the full image tag string) if the digest
format is absent. Displayed as a small subtitle under each pod name in the table.

**Cluster page Worker Pools table shows a live idle countdown.** `GET /api/worker-pools`
returns all non-deleted pools. Ready concurrent pools with a `warm_until` value display
a live M:SS countdown in the "Warm For" column (amber, turns red when expiring). The
ticker runs only when warm pools are present. Default pool never shows a countdown. A
**Release** button immediately tears down the StatefulSet and Service; disabled on
`in_use` pools.

**Status badges in `RunDetailPage` reflect live run sub-phases.** While
`run.status === 'running'`, a finer-grained `displayStatus` is derived from live
log parse state: `initializing` (purple, before warmup traffic log line), `warmup`
(blue, after "Starting warm-up traffic"), `running` (green, after "Starting
benchmark traffic"). During cooldown: `cooldown` (cyan). Pending sweep runs:
`queued` (gray). Do NOT seed `warmupStartedAt` from `run.started_at` in
`loadRun` — `started_at` is the Job creation time (JVM init), not the moment
warmup traffic begins, which would incorrectly show "warming up" during
initializing.

**`warmup_started_at` and `benchmark_started_at` are stored in the `runs` table.**
When the backend detects "Starting warm-up traffic" / "Starting benchmark traffic"
in the log stream, it writes UTC timestamps to these columns via `_record_phase_ts`
in `omb_runner.py`. `loadRun` seeds `warmupStartedAt`/`benchmarkStartedAt` state
from these server values so the progress bar is accurate after navigation. The WS
handler guards with `prev => prev ?? Date.now()` so replayed log lines never
overwrite the server-anchored timestamps. Both columns are added by ALTER TABLE
migrations in `init_db`.

**NewRunPage prefills from the most recent run.** On mount it calls `listRuns`
then `getRun(runs[0].id)` to seed `initialDriverContent` and
`initialWorkload`. If navigating from WorkloadLibrary (`location.state?.workloadContent`),
the prefill fetch is skipped and the library content is used instead. If
`driverInitOverride` or `workloadInitOverride` state is set (from the in-page
library drawer), those values take precedence over both paths.

**NewRunPage layout: sweep section above the 2×2 panel grid.** The page renders
top-to-bottom: (1) header card with name, launch button, and projected load
(including runtime estimate: warmup + bench duration per run, total sweep time);
(2) Parameter Sweep card with toggle, cooldown input, and Driver (left) + Workload
(right) axis panels; (3) 2×2 CSS grid — top row: Driver form panel (blue accent) +
Workload form panel (green accent), each with a `PanelHeader` that includes a
"Browse library" button; bottom row: Driver YAML panel + Workload YAML panel
(darker `#0d1018`). The form is constrained to `maxWidth: 1400px, margin: 0 auto`.

**Library drawer (`components/LibraryDrawer.jsx`) replaces navigation to the library page.** Each
panel header has a "Browse library" button that opens a fixed 440px right-side drawer
with a semi-transparent backdrop. The drawer fetches `/api/drivers` or `/api/workloads`
on open and shows bundled + custom sections. Clicking an entry toggles an inline YAML
preview; "Use this config" calls `onApply(content, name)`. The parent (`NewRunPage`)
sets `driverInitOverride`/`workloadInitOverride`, sets the YAML state directly, and
increments `driverFormKey`/`workloadFormKey` to force the form to re-mount with the
new `initialYaml`. A `window.confirm` fires if the form already has content. All
buttons inside the drawer must carry `type="button"` — the drawer renders inside the
`<form>` element and untyped buttons default to `type="submit"`.

## Future work specs

- `claude/hdr-live-latency.md` — live HDR P99 charts during a run by polling
  `/cumulative-latencies` on worker pods (same data as final output)
- `claude/ws-phase-events.md` — server-push phase events via WebSocket to
  eliminate client-side state inference and race conditions in sweep navigation

## Driver and Workload form architecture

Both forms use a **key/value row model** — each config section is a list of
`{_id, key, value}` rows rendered by a `PropertySection` / `WorkloadSection`
component. Do not convert them back to fixed named inputs.

**DriverForm** (`components/DriverForm.jsx`) sections:
- Topic Config → `topicConfig` YAML block scalar
- Producer Config → `producerConfig` YAML block scalar
- Consumer Config → `consumerConfig` YAML block scalar
- Common Config → `commonConfig` YAML block scalar — **always regenerated from
  cluster Settings on form init, never from stored YAML**. Stored YAML uses
  `yaml.dump()` format which the manual parser only partially handles. Collapsed
  behind a `▶ COMMON CONFIG` twisty by default; expand to edit SASL overrides.

**WorkloadForm** (`components/WorkloadForm.jsx`) sections: Topology, Load, Timing,
Payload, Additional. All sections serialize to flat `key: value` YAML lines.
`parseWorkloadYaml` (the backward-compat export used by `RunDetailPage`) is
re-exported from `workloadFormUtils.js` — do not remove this re-export.

**Utility modules:**
- `lib/driverFormUtils.js` — `DRIVER_OPTIONS`, `KNOWN_PROP_OPTIONS`,
  `parseDriverYaml`, `buildDriverYaml`, `deriveProtocol`, `buildCommonConfigFromCluster`
- `lib/workloadFormUtils.js` — `DEFAULT_*_ROWS`, `WORKLOAD_KNOWN_PROP_OPTIONS`,
  `WORKLOAD_KNOWN_PROP_TYPES`, `WORKLOAD_PROP_HINTS`, `parseWorkloadYamlToRows`,
  `buildWorkloadYaml`, `parseWorkloadYaml`

**Adding a new smart dropdown to the driver form:** add one entry to
`KNOWN_PROP_OPTIONS` in `driverFormUtils.js` and a matching test in
`driverFormUtils.test.js`. The `PropertySection` component picks it up
automatically — no other changes needed.

**`useRandomizedPayloads` is a toggle type** in `WORKLOAD_KNOWN_PROP_OPTIONS`.
`randomizedPayloadPoolSize` is dimmed and suppressed from YAML output when
`useRandomizedPayloads` is `'false'`. Both rows are always injected into the
Payload section at init time regardless of what was in stored YAML.

**Section divider colors:** driver form uses indigo `#818cf8`; workload form uses
green `#4ade80`. Both use the same `LABEL ———` flex-row visual pattern.

## Driver library

`/api/drivers` mirrors `/api/workloads` exactly — same `{bundled, custom}` response
shape, same CRUD endpoints, same `is_bundled` read-only guard. The `Driver` model
lives in `models.py`; schemas (`DriverOut`, `DriverCreate`, `DriverUpdate`) in
`schemas.py`; router in `routers/drivers.py`.

Five bundled driver YAMLs live in `control-plane/drivers/` and are copied into the
image at `/app/drivers/` by the Dockerfile. `seed_bundled_drivers()` in
`services/seeder.py` seeds them on first startup (no-ops if any bundled driver row
exists). Driver names: `kafka-acks-1-throughput`, `kafka-acks-all-durable`,
`kafka-acks-1-low-latency`, `redpanda-acks-all-throughput`, `redpanda-acks-all-strict`.

Do not add `last_used_at` or `last_used_run_id` to the Driver model — drivers are
referenced by content, not by run history (unlike workloads).

## SQLite database

The SQLite database file is at `/data/omb_ui.db` inside the control-plane pod
(mounted from the PersistentVolume). The path is **not** `/data/omb.db`.

## Build order for implementation

All sessions complete.

1. ~~Session 1: Repo scaffold + worker image~~ ✓
2. ~~Session 2: Terraform modules~~ ✓
3. ~~Session 3: Helm chart~~ ✓
4. ~~Session 4: Control plane migration~~ ✓
5. ~~Session 5: UI changes~~ ✓
6. ~~Session 6: CI/CD + docs~~ ✓

## Reference docs

- claude/terraform-notes.md — per-cloud Terraform specifics
- claude/ui-guidance.md — original UI screen specs written before implementation;
  the actual UI has evolved significantly from these specs. Read the code, not
  this file, before making frontend changes.
- OMB repo: https://github.com/redpanda-data/openmessaging-benchmark
  Worker image source and workload examples
