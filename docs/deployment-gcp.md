# GCP (GKE) Deployment Guide

This guide walks you through deploying omb-k8s on Google Kubernetes Engine (GKE) for a customer engagement. You will provision a GKE cluster with Terraform, install the Helm chart, and run your first benchmark — all in under 20 minutes.

---

## 1. Prerequisites

Ensure the following tools are installed and configured on your local machine before starting.

| Tool | Minimum version | Install |
|------|----------------|---------|
| Terraform | >= 1.5 | https://developer.hashicorp.com/terraform/install |
| gcloud CLI | >= 450 | https://cloud.google.com/sdk/docs/install |
| kubectl | >= 1.28 | https://kubernetes.io/docs/tasks/tools/ |
| Helm | >= 3.12 | https://helm.sh/docs/intro/install/ |

**Authenticate the gcloud CLI and set your project:**

```bash
gcloud auth application-default login
gcloud config set project <your-gcp-project-id>
```

> **Note:** `gcloud auth application-default login` is required for Terraform's Google provider. `gcloud auth login` alone is not sufficient.

---

## 2. Clone the repo

```bash
git clone https://github.com/supahcraig/omb-k8s.git
cd omb-k8s
```

All paths in this guide are relative to the repo root.

---

## 3. Create your engagement tfvars file

```bash
cd terraform/gcp
cp terraform.tfvars.example terraform.tfvars
```

Open `terraform/gcp/terraform.tfvars` and fill in your values:

```hcl
# GCP project where all resources will be created.
project_id = "my-gcp-project-id"

# GCP region for the VPC subnet.
region = "us-central1"

# GCP zone for the cluster and node pool.
# Single-zone keeps node count exact — regional clusters multiply by 3.
zone = "us-central1-a"

# cluster_name is optional — leave commented out to auto-generate (e.g. omb-relaxed-lemur).
# cluster_name = "omb-acme-20240101"

# CIDR for the new VPC subnet. Must not overlap with the target cluster.
vpc_cidr = "10.1.0.0/16"

# Network self_link of the Redpanda/Kafka cluster VPC to peer with.
# Format: projects/PROJECT_ID/global/networks/NETWORK_NAME
# For Redpanda Cloud: obtain the network self_link from the console (Networking tab).
# Leave empty ("") to skip VPC peering.
target_network = "projects/redpanda-project-id/global/networks/redpanda-vpc"
target_cidr    = "172.16.0.0/16"

labels = {
  project    = "omb-benchmarking"
  customer   = "acme"
  managed-by = "terraform"
}
```

> **Important:** Never commit the filled-in tfvars file — it is gitignored by default.

---

## 4. Run Terraform

```bash
# Still inside terraform/gcp/
terraform init
terraform apply
```

Type `yes` when prompted. GKE provisioning typically takes **3–5 minutes**.

Terraform creates:
- A VPC and subnet with the specified CIDR
- A GKE Standard-mode cluster (Standard mode is required — Autopilot does not permit `hostNetwork: true` which workers need)
- A control-plane node pool: 2× n2-standard-4 (fixed, no autoscaling)
- A benchmark-worker node pool: n2-standard-16, autoscales 0–20 nodes
- A firewall rule allowing port 9080 (OMB worker port) within the VPC
- Optional VPC peering to your target cluster

After apply, note the outputs:

```bash
terraform output
```

Key outputs:

| Output | Description |
|--------|-------------|
| `cluster_name` | GKE cluster name (auto-generated if not specified) |
| `terraform_operator_ip` | Your public IP — pass to helm install as `controlPlane.allowedCIDRs` |
| `kubeconfig_command` | Ready-to-run `gcloud` credentials command |
| `vpc_id` | Network self_link (share with Redpanda team to complete the peering handshake) |

**GCP peering note:** GCP VPC peering requires both sides to initiate. After apply, the peering status will be `INACTIVE` until the Redpanda team creates the reverse peering from their network to yours. Share the `vpc_id` output value with your Redpanda contact and ask them to complete the handshake via the Redpanda Cloud console.

---

## 5. Configure kubectl credentials

Set `KUBECONFIG` **before** running the credentials command so this cluster's config is isolated from `~/.kube/config`:

```bash
export KUBECONFIG=$(pwd)/kubeconfig
$(terraform output -raw kubeconfig_command)
```

Verify the cluster is reachable and all nodes are ready:

```bash
kubectl get nodes
```

Expected output: 4 nodes in `Ready` state — 2 from the control-plane pool and 2 from the benchmark-worker pool.

> **Tip:** Add `export KUBECONFIG=<absolute-path-to>/terraform/gcp/kubeconfig` to your shell profile for this engagement so you don't have to re-export it in each new terminal session.

---

## 6. Install the Helm chart

Add the Prometheus community chart repository (one-time per machine), then install:

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm dependency build charts/omb
helm install omb charts/omb -n omb --create-namespace \
  -f charts/omb/values-gcp.yaml \
  --set "controlPlane.allowedCIDRs[0]=$(terraform -chdir=terraform/gcp output -raw terraform_operator_ip)/32"
```

This deploys:
- The control-plane pod (FastAPI + React UI, SQLite on a PersistentVolume)
- The OMB worker StatefulSet (2 replicas by default)
- Prometheus and Grafana (via kube-prometheus-stack)
- Cluster Autoscaler (GKE manages this natively — no IRSA or IAM role configuration needed, unlike EKS)

Wait for all pods to reach `Running` state:

```bash
kubectl get pods -n omb --watch
```

Press `Ctrl+C` once everything is running.

---

## 7. Get the UI address

GCP LoadBalancer services expose an IP address (not a hostname):

```bash
kubectl get svc omb-control-plane -n omb -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

The IP may take 1–2 minutes to be assigned after Helm install. Re-run the command if it returns empty output.

Open the UI at `http://<IP-address>` in your browser.

---

## 8. Configure cluster connectivity

Open **Settings** in the left sidebar, then the **Cluster Connectivity** tab.

| Field | Value |
|-------|-------|
| Seed brokers | One or more broker addresses. Type each one and press Enter. Redpanda Cloud: single bootstrap server (e.g. `seed-abc123.us-central1.cloud.redpanda.com:9092`). Self-managed: one address per broker. |
| TLS | Enable if the cluster requires it. Redpanda Cloud always requires TLS. |
| SASL | Enable if the cluster requires authentication. Redpanda Cloud always requires SASL. |
| SASL mechanism | SCRAM-SHA-256 for Redpanda Cloud. SCRAM-SHA-256, SCRAM-SHA-512, or PLAIN for self-managed. |
| Username / Password | Your broker credentials. |

Click **Save**.

---

## 9. Configure Prometheus

Open **Settings → Prometheus** tab.

The in-cluster Prometheus URL is pre-configured and does not need to be changed. Toggle **Enable Prometheus** to on and click **Save**.

Worker CPU, memory, and throttle metrics will begin appearing in run charts once the first benchmark starts.

---

## 10. Verify workers are ready

From the UI, open **OMB Cluster** in the left sidebar. All worker pods should show a green health indicator.

You can also verify from the command line:

```bash
kubectl get pods -n omb
```

All `omb-worker-*` pods should be in `Running` state with `1/1` containers ready. If any pods are in `Pending` state, the benchmark-worker node pool may still be scaling up — wait 1–2 minutes and recheck.

To scale the number of workers (before running a benchmark), use the **Scale** control at the bottom of the left sidebar in the UI, or:

```bash
kubectl scale statefulset omb-worker -n omb --replicas=<N>
```

---

## 11. Run your first benchmark

1. Click **New Run** in the left sidebar.
2. Fill in the **Driver** panel:
   - Select `Redpanda` or `Kafka` as the driver type.
   - The form pre-fills seed brokers, TLS, and SASL from Settings automatically.
3. Fill in the **Workload** panel:
   - Set topics, partitions, producers, consumers, and message size as appropriate.
   - `sampleRateMillis` defaults to `1000` (one stat line per second) for good live chart resolution.
4. Give the run a name and click **Launch**.

The UI navigates to the run detail page and streams live logs. Charts for throughput, latency, and worker resource usage update in real time.

Results are saved to SQLite on the PersistentVolume and remain accessible in **Benchmark Runs** for the lifetime of the engagement.

---

## Teardown

When the engagement is complete, tear down in this order to avoid orphaned cloud resources:

```bash
helm uninstall omb -n omb
cd terraform/gcp
terraform destroy
```

> **Warning:** `helm uninstall` does not stop GKE nodes — you must run `terraform destroy` to stop billing. Keep your local Terraform state directory (`terraform/gcp/terraform.tfstate`) until after destroy completes. Deleting the state file before destroy makes it impossible to clean up resources with Terraform.
