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
│    Pure OMB worker, port 8080               │
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
    engagements/           Per-engagement .tfvars files (gitignored)
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
predictable DNS names (omb-worker-0.omb-worker:8080, omb-worker-1.omb-worker:8080,
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

**SQLite on a PersistentVolume, not Postgres.** Results are engagement-scoped.
SQLite is sufficient, requires zero migration from the existing codebase, and
survives pod restarts via the PV. Do not introduce Postgres.

**JVM heap is fixed in the Dockerfile entrypoint, not configurable.** Worker pods
are standardized at 4 vCPU / 8GB. Heap is set to -Xms4G -Xmx4G. Scaling is
horizontal (more pods) not vertical (bigger pods or more heap). Do not expose JVM
settings as Helm values.

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
create/delete ConfigMaps, get/update StatefulSets, get Pods. Do not mount or
reference external kubeconfig files.

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
group (`vpc_config[0].cluster_security_group_id`) and the OMB workers SG (port 8080).
Do not remove the launch template or the node group will lose the port 8080 rules.

**GKE uses Standard mode, not Autopilot.** `hostNetwork: true` on worker pods
requires Standard mode — Autopilot does not permit hostNetwork. Do not change
`remove_default_node_pool = true` / `initial_node_count = 1` pattern; this is the
correct way to use a separately managed node pool with Standard GKE clusters.

**Cluster provisioning is out of scope.** If you find yourself writing code that
creates Redpanda broker nodes or interacts with the Redpanda Cloud API, stop.

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
3. SE clicks Run
4. Control plane writes driver + workload YAML into a k8s ConfigMap
5. Control plane creates a k8s Job mounting the ConfigMap:
   bin/benchmark --drivers /etc/omb/driver.yaml /etc/omb/workload.yaml \
     --workers http://omb-worker-0.omb-worker:8080,...
6. UI streams Job logs via websocket
7. On completion, results parsed and stored in SQLite, run record finalized

## Who uses this

Redpanda Solutions Engineers running customer benchmarks. They are comfortable
with Helm and k8s basics. They are not k8s experts. The UI is their primary
interface during an engagement — they should not need kubectl for day-to-day
operations after initial deployment.

## Deployment workflow

1. Clone repo to local machine
2. Copy terraform/<cloud>/terraform.tfvars.example to terraform/engagements/<customer>.tfvars and fill in values
3. cd terraform/<cloud> && terraform init && terraform apply -var-file=../engagements/<customer>.tfvars (provisions k8s cluster + VPC + peering)
4. aws/gcloud/az eks/gke/aks get-credentials (configure local kubectl)
5. helm install omb charts/omb -f charts/omb/values-<cloud>.yaml -f my-values.yaml
6. Open the UI at the LoadBalancer address
7. Configure cluster connectivity and Prometheus in Settings
8. Run benchmarks
9. helm uninstall omb && terraform destroy when engagement is complete

## Worker memory and JVM settings

Worker pods are standardized at 4 vCPU / 8GB memory. This is fixed — do not
make it configurable. JVM heap flags are set in the worker Dockerfile entrypoint
as fixed values. These are not Helm values, not env vars, not configurable by
the SE.

Required JVM flags in the entrypoint script:
  -Xms4G -Xmx4G
  -XX:+UseContainerSupport
  -XX:+UseG1GC
  -XX:MaxGCPauseMillis=10
  -XX:+ParallelRefProcEnabled
  -XX:+PerfDisableSharedMem
  -XX:+DisableExplicitGC

-XX:+UseContainerSupport ensures the JVM respects container memory limits rather
than seeing the full host memory (default on JDK 11+ but be explicit).
-XX:+PerfDisableSharedMem prevents GC pauses from shared memory operations,
which matters on benchmark workloads.

The correct response to needing more throughput is adding more worker pods via
the UI scaling control, not changing instance types or JVM settings. Document
this clearly. Node pools in each Terraform module use m5.4xlarge on AWS,
n2-standard-16 on GCP, Standard_D16s_v3 on Azure — 4xlarge instances provide
dedicated network interfaces which eliminates noisy neighbor network contention.
Each node comfortably fits ~8 worker pods (leaving headroom for system pods)
before the Cluster Autoscaler adds another node.

## Build order for implementation

Always implement in this order. Each session depends on the previous being
done and validated before starting the next.

1. Session 1: Repo scaffold + worker image
2. Session 2: Terraform modules
3. Session 3: Helm chart
4. Session 4: Control plane migration
5. Session 5: UI changes
6. Session 6: CI/CD + docs

## Reference docs

- claude/ui-guidance.md — detailed UI screen specifications
- claude/terraform-notes.md — per-cloud Terraform specifics
- Existing UI codebase: https://github.com/supahcraig/omb_ui
  Read this carefully before touching control-plane/
- OMB repo: https://github.com/redpanda-data/openmessaging-benchmark
  Worker image source and workload examples
