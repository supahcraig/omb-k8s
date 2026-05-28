# Deploying omb-k8s on Azure (AKS)

This guide walks through deploying the omb-k8s benchmarking platform on Azure Kubernetes Service for a single customer engagement. You will provision an AKS cluster with Terraform, install the Helm chart, configure connectivity to your target Redpanda or Kafka cluster, and run your first benchmark.

---

## 1. Prerequisites

The following tools must be installed and configured on your local machine before you begin.

- **Terraform** ≥ 1.5 — [install](https://developer.hashicorp.com/terraform/install)
- **Azure CLI** (`az`) — [install](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)
- **kubectl** — [install](https://kubernetes.io/docs/tasks/tools/)
- **Helm** ≥ 3.12 — [install](https://helm.sh/docs/intro/install/)
- **git**

Authenticate with Azure before proceeding:

```bash
az login
```

Verify you are targeting the correct subscription:

```bash
az account show --query "{name:name, id:id}" -o table
```

To switch subscriptions:

```bash
az account set --subscription "<subscription-id>"
```

---

## 2. Clone the repo

```bash
git clone https://github.com/supahcraig/omb-k8s.git
cd omb-k8s
```

All commands in this guide assume your working directory is the repo root unless otherwise noted.

---

## 3. Create your engagement tfvars file

The engagement-specific tfvars file lives outside the Terraform working directory so it is never accidentally committed. The `terraform/engagements/` directory is gitignored.

```bash
mkdir -p terraform/engagements
cp terraform/azure/terraform.tfvars.example terraform/engagements/<customer>.tfvars
```

Open `terraform/engagements/<customer>.tfvars` in an editor and fill in every value:

```hcl
# Azure resource group for all engagement resources.
resource_group_name = "omb-acme-20240101-rg"

# Azure region. Use: az account list-locations --output table
location = "eastus"

# Short descriptive cluster name. Used as prefix for all resource names.
cluster_name = "omb-acme-20240101"

# Address space for the new VNet. Must not overlap with the target cluster VNet.
vnet_address_space    = ["10.2.0.0/16"]
subnet_address_prefix = "10.2.0.0/20"

# Resource ID of the Redpanda/Kafka VNet to peer with.
# For BYOC: obtain from the Redpanda Cloud BYOC UI (Networking tab).
# Format: /subscriptions/<sub-id>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<vnet>
# Leave empty ("") to skip VNet peering.
target_vnet_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/redpanda-rg/providers/Microsoft.Network/virtualNetworks/redpanda-vnet"

tags = {
  project    = "omb-benchmarking"
  customer   = "acme"
  managed_by = "terraform"
}
```

**VNet address space:** Choose a CIDR that does not overlap with the Redpanda BYOC or self-hosted VNet. The OMB VNet and the target VNet must have non-overlapping CIDRs for VNet peering to succeed.

**`target_vnet_id`:** Set to the full Azure resource ID of the Redpanda VNet. For BYOC clusters, find this in the Redpanda Cloud console under Networking. Leave as `""` if you are not using VNet peering (e.g., brokers are reachable over the public internet).

> **Keep this file out of git.** The `terraform/engagements/` directory is already listed in `.gitignore`. Never commit a filled-in tfvars file — it contains network topology details specific to the customer engagement.

---

## 4. Run Terraform

Change into the Azure Terraform directory and initialize:

```bash
cd terraform/azure
terraform init
```

Plan to review what will be created:

```bash
terraform plan -var-file=../../terraform/engagements/<customer>.tfvars
```

Apply:

```bash
terraform apply -var-file=../../terraform/engagements/<customer>.tfvars
```

Type `yes` when prompted. Provisioning an AKS cluster typically takes 8–12 minutes.

After apply completes, note the outputs:

```bash
terraform output cluster_name
terraform output kubeconfig_command
```

> **Terraform state is local.** There is no remote state backend. Do not delete the `terraform/azure/terraform.tfstate` file until after you have run `terraform destroy` at the end of the engagement. If you lose state, the cluster will need to be destroyed manually via the Azure portal.

> **AKS node pool renaming:** The `default_node_pool` in this module is named `controlplane`. If a previous engagement used a different name, renaming it forces destruction and recreation of the entire AKS cluster. Do not attempt an in-place upgrade — re-deploy fresh.

Return to the repo root when done:

```bash
cd ../..
```

---

## 5. Configure kubectl credentials

Set `KUBECONFIG` to an engagement-specific file **before** running `get-credentials`. This isolates the new cluster from any existing entries in `~/.kube/config`.

```bash
export KUBECONFIG=$(pwd)/kubeconfig
```

Fetch credentials from AKS, writing them to the file specified by `KUBECONFIG`:

```bash
az aks get-credentials \
  --resource-group "$(cd terraform/azure && terraform output -raw -var-file=../../terraform/engagements/<customer>.tfvars resource_group_name 2>/dev/null || echo '<resource-group>')" \
  --name "$(cd terraform/azure && terraform output -raw cluster_name 2>/dev/null || echo '<cluster-name>')" \
  --file $(pwd)/kubeconfig
```

Or use the pre-formatted command from Terraform output (append `--file $(pwd)/kubeconfig`):

```bash
az aks get-credentials \
  --resource-group omb-acme-20240101-rg \
  --name omb-acme-20240101 \
  --file $(pwd)/kubeconfig
```

Verify the connection:

```bash
kubectl get nodes
```

You should see nodes for both the `controlplane` and `workers` node pools.

> **Remember to re-export `KUBECONFIG` in every new shell session** for this engagement:
> ```bash
> export KUBECONFIG=/path/to/omb-k8s/kubeconfig
> ```

---

## 6. Install the Helm chart

Add the Prometheus community Helm repository (one-time per machine):

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
```

Download chart dependencies into `charts/omb/charts/`:

```bash
helm dependency build charts/omb
```

Install the chart into the `omb` namespace:

```bash
helm install omb charts/omb -n omb --create-namespace \
  -f charts/omb/values-aks.yaml
```

The AKS values file sets:

| Value | Setting |
|-------|---------|
| `storage.storageClassName` | `managed-premium` |
| `worker.resources.cpu` | `15` |
| `worker.resources.memory` | `58Gi` |

Wait for all pods to reach Running status:

```bash
kubectl get pods -n omb --watch
```

Press `Ctrl-C` when all pods show `Running` or `Completed`.

---

## 7. Get the UI address

Azure LoadBalancer services expose an IP address (not a hostname). Retrieve it with:

```bash
kubectl get svc omb-control-plane -n omb -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

It may take 2–3 minutes for Azure to assign the external IP after the Service is created. If the command returns empty output, wait a moment and retry.

Once the IP is available, open the UI in a browser:

```
http://<EXTERNAL-IP>
```

---

## 8. Configure cluster connectivity

Open the UI, navigate to **Settings**, and select the **Cluster** tab.

### BYOC (Redpanda Cloud)

BYOC clusters require TLS and SASL authentication.

| Field | Value |
|-------|-------|
| Seed brokers | Single bootstrap server (e.g. `seed-abc123.us-east-1.aws.redpanda.cloud:9092`) |
| TLS | Enabled |
| SASL | Enabled |
| SASL mechanism | `SCRAM-SHA-256` |
| SASL username | Your Redpanda Cloud service account username |
| SASL password | Your Redpanda Cloud service account password |

Click **Save**.

### Self-hosted

Self-hosted clusters may or may not require TLS or SASL.

| Field | Value |
|-------|-------|
| Seed brokers | Comma-separated broker addresses (e.g. `10.2.1.10:9092,10.2.1.11:9092,10.2.1.12:9092`) |
| TLS | Enable if the cluster uses TLS |
| SASL | Enable if the cluster requires authentication |
| SASL mechanism | `SCRAM-SHA-256`, `SCRAM-SHA-512`, or `PLAIN` as appropriate |
| SASL username | Your cluster username (if SASL enabled) |
| SASL password | Your cluster password (if SASL enabled) |

Click **Save**.

> **VNet peering:** Worker pods communicate with brokers over the internal VNet peering connection established by Terraform. Broker addresses should be the private IPs or internal DNS names, not public endpoints. If peering was skipped (`target_vnet_id = ""`), brokers must be reachable over the public internet.

---

## 9. Configure Prometheus

In-cluster Prometheus is deployed as part of the Helm chart and is pre-configured. No external Prometheus URL is required.

1. Open **Settings** → **Prometheus** tab.
2. Toggle Prometheus collection **on**.
3. Click **Save**.

The collector uses the in-cluster kube-prometheus-stack URL automatically. Worker CPU and memory metrics will appear in run detail charts once benchmarks start.

---

## 10. Verify workers are ready

Check that all worker pods are Running and healthy before launching a benchmark:

```bash
kubectl get pods -n omb
```

Expected output (with default replica count of 2):

```
NAME                             READY   STATUS    RESTARTS   AGE
omb-control-plane-...            1/1     Running   0          5m
omb-worker-0                     1/1     Running   0          5m
omb-worker-1                     1/1     Running   0          5m
prometheus-...                   2/2     Running   0          5m
grafana-...                      1/1     Running   0          5m
```

You can also check worker health in the UI by navigating to **OMB Cluster**. Each worker row shows a green health dot when the pod is reachable. If a worker shows red, use the restart button (↺) on that row to cycle the pod.

To scale workers up before your first run, use the **Worker scaling control** at the bottom of the left sidebar. Enter the desired replica count and click **Scale**.

---

## 11. Run your first benchmark

1. Navigate to **New Run** in the sidebar.
2. The form prefills from the most recent run. On first use it will be empty.
3. Fill in the **Driver** panel:
   - Select driver type (`kafka` or `redpanda`)
   - The seed brokers and auth fields are populated from Settings automatically
4. Fill in the **Workload** panel:
   - Set topic count, partitions, producers, consumers, and message size as appropriate for your benchmark
   - `sampleRateMillis` defaults to `1000` (one stat line per second) — leave this unless you expect a very long run
5. Give the run a name in the header field.
6. Click **Launch**.

The UI navigates to the run detail page and begins streaming live logs. Worker CPU and memory charts populate as Prometheus samples are collected. When the run completes, summary metrics (p50/p99 latency, throughput) appear below the charts.

### Tearing down after the engagement

When the engagement is complete, uninstall the Helm chart and destroy the cluster:

```bash
helm uninstall omb -n omb
```

```bash
cd terraform/azure
terraform destroy -var-file=../../terraform/engagements/<customer>.tfvars
```

Type `yes` when prompted. This removes the AKS cluster, VNet, resource group, and all associated Azure resources.

> Retain your `terraform/engagements/<customer>.tfvars` file and the `terraform.tfstate` file until `terraform destroy` has completed successfully. Once destroy is confirmed, both files can be deleted.
