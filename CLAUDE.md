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

Each subdirectory has its own `CLAUDE.md` with decisions specific to that area:
- `control-plane/CLAUDE.md` — FastAPI backend, React frontend, OMB runtime quirks
- `terraform/CLAUDE.md` — per-cloud Terraform decisions
- `worker/CLAUDE.md` — worker image and JVM decisions

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

**hostNetwork: true on worker pods.** Bypasses CNI overhead for accurate benchmark
results. The control plane does not use hostNetwork.

**Worker pods require `dnsPolicy: ClusterFirstWithHostNet`.** When `hostNetwork: true`
is set, the default `dnsPolicy` of `ClusterFirst` breaks — the pod uses the host's
DNS instead of the cluster DNS, so `omb-worker-0.omb-worker.<ns>.svc.cluster.local`
does not resolve. Setting `dnsPolicy: ClusterFirstWithHostNet` restores cluster DNS
while keeping host networking. Do not remove this field.

**k8s API calls use in-cluster service account credentials.** The control plane
pod has a ServiceAccount with a Role that permits: create/delete Jobs,
create/delete ConfigMaps, get/update StatefulSets, get/delete Pods. Do not mount
or reference external kubeconfig files.

**Cloud differences are isolated in per-cloud values files.** The Helm chart is
cloud-agnostic. values-aws.yaml, values-gcp.yaml, values-aks.yaml contain only
what differs (StorageClass names, node pool sizing, etc.).

**Images are published to ghcr.io.** Not Docker Hub. Not a cloud-native registry.
GitHub Container Registry keeps everything in one place and has no pull rate limits.

**No CPU limit on worker pods — only a CPU request.** This prevents cgroup CPU
throttling architecturally. Without a CPU limit, the kernel never throttles the
JVM even at full utilization; resource exhaustion degrades throughput instead of
appearing as an artificial ceiling. The memory limit equals the memory request.

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

**Cluster provisioning is out of scope.** If you find yourself writing code that
creates Redpanda broker nodes or interacts with the Redpanda Cloud API, stop.

**Worker pool lifecycle: provisioning → ready → in_use → ready → (deleted by SE).**
New pools are provisioned by the SE from the Cluster page; `claim_pool` marks a
`ready` pool as `in_use` when a run starts; it returns to `ready` when the run
completes. The default pool (`id="default"`) is always present and never deleted.
See `control-plane/CLAUDE.md` for implementation details.

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
3. SE selects a worker pool from the **Worker Pool** dropdown and clicks Run — HTTP
   returns immediately with `status="pending"`; `_bg_launch` runs as a background
   task. `claim_pool` marks the selected `ready` pool as `in_use`. If no ready pool
   exists, launch is blocked by the UI before the request is sent.
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
   writes them to `prometheus_samples`. The Prometheus service is at:
   `http://omb-kube-prometheus-stack-prometheus.{namespace}.svc.cluster.local:9090`
   The collector silently no-ops if Prometheus is unreachable.
8. On completion, `_finish_run` reads `/data/results/run-{id}` from the PVC
   (high-fidelity JSON with full per-second arrays), falls back to log parsing
   if the file is absent, stores metrics in SQLite, then renames the result file
   to `run-{id}.json` (standalone run) or `sweep-{sweep_id}-run-{id}.json`
   (sweep run). Files persist on the PVC for later analysis.

## Who uses this

Redpanda Solutions Engineers running customer benchmarks. They are comfortable
with Helm and k8s basics. They are not k8s experts. The UI is their primary
interface during an engagement — they should not need kubectl for day-to-day
operations after initial deployment.

## Deployment workflow

1. Clone repo to local machine
2. `cd terraform/<cloud> && cp terraform.tfvars.example terraform.tfvars` and fill in values (terraform.tfvars is gitignored)
3. `export KUBECONFIG=$(pwd)/terraform/<cloud>/kubeconfig` (isolates this cluster's config from ~/.kube/config; set before get-credentials)
4. `terraform init && terraform apply` (provisions k8s cluster + VPC + peering)
5. `aws/gcloud/az eks/gke/aks get-credentials` (configure local kubectl; writes to $KUBECONFIG path)
6. `helm repo add prometheus-community https://prometheus-community.github.io/helm-charts && helm repo update` (one-time per machine; required before dependency build)
7. `helm dependency build charts/omb` (downloads kube-prometheus-stack and other chart deps into charts/omb/charts/; safe to re-run)
8. On AWS: `terraform output -raw helm_install_command | bash` — this runs the pre-filled helm install command with all CA and CIDR values substituted. On GCP/Azure: `helm install omb charts/omb -n omb -f charts/omb/values-<cloud>.yaml --set "controlPlane.allowedCIDRs[0]=$(terraform output -raw terraform_operator_ip)/32"`
9. Open the UI at the LoadBalancer address
10. Configure cluster connectivity and Prometheus in Settings
11. Run benchmarks
12. `helm uninstall omb && terraform destroy` when engagement is complete

## CI/CD — image builds

Both `.github/workflows/build-control-plane.yml` and `.github/workflows/build-worker.yml` trigger automatically on `push: branches: [main]`. Pushing to main is sufficient — do not manually trigger `gh workflow run` for main branch deploys.

To test a feature branch before merging, use:
```bash
gh workflow run build-control-plane.yml --repo supahcraig/omb-k8s --ref <branch-name>
```

Images are tagged with the full git SHA (`github.sha`) and also `latest`. To deploy a new image after a push to main:
```bash
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

## Build order for implementation

All sessions complete.

1. ~~Session 1: Repo scaffold + worker image~~ ✓
2. ~~Session 2: Terraform modules~~ ✓
3. ~~Session 3: Helm chart~~ ✓
4. ~~Session 4: Control plane migration~~ ✓
5. ~~Session 5: UI changes~~ ✓
6. ~~Session 6: CI/CD + docs~~ ✓

## Reference docs

- `control-plane/CLAUDE.md` — FastAPI backend, React frontend, OMB runtime quirks, form architecture
- `terraform/CLAUDE.md` — per-cloud Terraform decisions
- `worker/CLAUDE.md` — worker image and JVM decisions
- `claude/terraform-notes.md` — per-cloud Terraform specifics (additional details)
- `claude/ui-guidance.md` — original UI screen specs written before implementation;
  the actual UI has evolved significantly from these specs. Read the code, not
  this file, before making frontend changes.
- OMB repo: https://github.com/redpanda-data/openmessaging-benchmark
  Worker image source and workload examples
