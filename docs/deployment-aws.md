# AWS (EKS) Deployment Guide

This guide walks through deploying omb-k8s on AWS EKS for a customer engagement.
You will provision the EKS cluster with Terraform, install the Helm chart, configure
cluster connectivity, and run your first benchmark — all through the UI.

---

## 1. Prerequisites

The following tools must be installed and configured before you start:

| Tool | Version | Notes |
|------|---------|-------|
| Terraform | >= 1.5 | `terraform -version` |
| AWS CLI | >= 2.x | `aws --version` |
| kubectl | >= 1.27 | `kubectl version --client` |
| Helm | >= 3.12 | `helm version` |
| git | any | — |

Your AWS credentials must be configured and have permission to create EKS clusters,
VPCs, IAM roles, and EBS volumes.

```bash
aws sts get-caller-identity   # confirm you are authenticated
```

---

## 2. Clone the repo

```bash
git clone https://github.com/supahcraig/omb-k8s.git
cd omb-k8s
```

---

## 3. Create your engagement tfvars file

```bash
cd terraform/aws
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform/aws/terraform.tfvars` and fill in your values:

```hcl
# cluster_name is optional — leave commented out to auto-generate (e.g. omb-relaxed-lemur).
# Set explicitly if you need a predictable name for tagging policies or customer docs.
# cluster_name = "omb-acme-20240101"

region             = "us-east-1"
vpc_cidr           = "10.0.0.0/16"
availability_zones = ["us-east-1a", "us-east-1b"]

# VPC ID of the cluster you are benchmarking
target_vpc_id = "vpc-0123456789abcdef0"
target_cidr   = "172.16.0.0/16"

# Optional: Redpanda broker security group ID.
# When set, Terraform adds an inbound rule allowing the OMB VPC CIDR on
# ports 9092–9093. If omitted, VPC routes work but broker connections will
# be refused at the SG layer.
# target_security_group_id = "sg-0abc123def456gh78"
```

> **Note:** `target_security_group_id` is optional. When set, Terraform adds
> an inbound rule to the broker security group for ports 9092–9093. Without it,
> VPC routes work but broker connections will be refused at the SG layer. Find
> the SG ID in the AWS console or Redpanda Cloud console under Networking.

---

## 4. Run Terraform

```bash
# Still inside terraform/aws/
terraform init
terraform apply
```

Review the plan, type `yes` to confirm. Provisioning takes **15–20 minutes** —
EKS control plane creation accounts for most of that time.

When `apply` completes, Terraform prints outputs including:

```
cluster_name                   = "omb-relaxed-lemur"   # auto-generated if not specified
region                         = "us-east-1"
terraform_operator_ip          = "203.0.113.42"
cluster_autoscaler_iam_role_arn = "arn:aws:iam::123456789012:role/omb-relaxed-lemur-cluster-autoscaler"
kubeconfig_command             = "aws eks update-kubeconfig --region us-east-1 --name omb-relaxed-lemur"
find_elb_sg_command            = "aws elb describe-load-balancers ..."
```

> **Important:** Keep your Terraform state files (`terraform/aws/terraform.tfstate`)
> until after `terraform destroy`. State is local — if you delete it before destroy,
> you will not be able to clean up cloud resources automatically.

The `aws-ebs-csi-driver` EKS addon is provisioned automatically by the Terraform
module. No manual addon installation is required.

---

## 5. Configure kubectl credentials

**Always set `KUBECONFIG` before running get-credentials** so this cluster's config
is written to a local file rather than polluting `~/.kube/config`.

```bash
# Still inside terraform/aws/
export KUBECONFIG=$(pwd)/kubeconfig
$(terraform output -raw kubeconfig_command)
```

The second command evaluates to something like:

```
aws eks update-kubeconfig --region us-east-1 --name omb-acme-20240101
```

Confirm connectivity:

```bash
kubectl get nodes
```

You should see the control-plane nodes (m5.xlarge) in `Ready` state. Worker nodes
(m5.4xlarge) appear later when the Cluster Autoscaler provisions them on first
benchmark run.

> **Tip:** Add `export KUBECONFIG=<absolute-path>/terraform/aws/kubeconfig` to your
> shell session or a `.envrc` file for this engagement. This prevents kubectl
> commands from accidentally targeting the wrong cluster.

---

## 6. Install the Helm chart

Run these commands from the repo root (not from `terraform/aws/`):

```bash
cd ../..   # back to repo root

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm dependency build charts/omb
helm install omb charts/omb -n omb --create-namespace \
  -f charts/omb/values-aws.yaml \
  --set clusterAutoscaler.clusterName=$(terraform -chdir=terraform/aws output -raw cluster_name) \
  --set clusterAutoscaler.region=$(terraform -chdir=terraform/aws output -raw region) \
  --set clusterAutoscaler.roleArn=$(terraform -chdir=terraform/aws output -raw cluster_autoscaler_iam_role_arn) \
  --set "controlPlane.allowedCIDRs[0]=$(terraform -chdir=terraform/aws output -raw terraform_operator_ip)/32" \
  --set kube-prometheus-stack.grafana.adminPassword=<your-grafana-password>

> **Important:** Always set a strong Grafana password at install time. The default is `changeme` — do not use it in customer engagements.
```

> **Note:** `helm dependency build` downloads `kube-prometheus-stack` and other
> chart dependencies into `charts/omb/charts/`. It is safe to re-run if the
> directory already exists.

Wait for all pods to reach `Running` or `Completed`:

```bash
kubectl get pods -n omb --watch
```

The initial rollout takes 2–3 minutes. You should eventually see:

- `omb-control-plane-*` — Running
- `omb-worker-0`, `omb-worker-1` — Running
- `omb-kube-prometheus-stack-*` — Running
- `omb-grafana-*` — Running
- `omb-cluster-autoscaler-*` — Running

---

## 7. Get the UI and Grafana addresses

AWS assigns a hostname (not an IP) to LoadBalancer services. There are two external services after install.

Retrieve both:

```bash
# Control plane UI
kubectl get svc omb-control-plane -n omb \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'

# Grafana
kubectl get svc omb-grafana -n omb \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

DNS propagation can take 1–3 minutes after the service is created. Open the hostnames in your browser once they resolve:

- Control plane UI: `http://<control-plane-hostname>/`
- Grafana: `http://<grafana-hostname>/` — login with `admin` and the password set during install

The Redpanda dashboard is pre-loaded under **Dashboards → Redpanda** in Grafana.

> **Tip:** LoadBalancer hostnames change if you `helm uninstall` and `helm install` again. Share both new addresses with the customer after any reinstall.

---

## 8. Configure cluster connectivity

Open the UI, click **Settings** in the left sidebar, then select the **Cluster** tab.

| Field | Value |
|-------|-------|
| Seed Brokers | One or more broker addresses. Type each one and press Enter. Redpanda Cloud: single bootstrap server (e.g. `seed-abc123.cloud.redpanda.com:9092`). Self-managed: one address per broker. |
| TLS | Enable if the cluster requires it. Redpanda Cloud always requires TLS. |
| SASL | Enable if the cluster requires authentication. Redpanda Cloud always requires SASL. |
| SASL Mechanism | SCRAM-SHA-256 for Redpanda Cloud. SCRAM-SHA-256, SCRAM-SHA-512, or PLAIN for self-managed (match your broker config). |
| Username / Password | Your broker credentials. |

Click **Save**.

> **Troubleshooting:** If benchmark runs fail immediately with a connection error,
> verify VPC peering routes are in place (`terraform output` should show no errors)
> and that the broker security group allows inbound traffic from the OMB VPC CIDR
> on port 9092 (9093 for TLS). See the note about `target_security_group_id` in
> Section 3.

---

## 9. Configure Prometheus

The in-cluster Prometheus (kube-prometheus-stack) is pre-configured and ready.
All you need to do is enable it in the UI.

1. Click **Settings** in the left sidebar.
2. Select the **Prometheus** tab.
3. Toggle Prometheus scraping **on**.
4. Click **Save**.

The collector uses the in-cluster service URL automatically — no URL entry is
required. Worker CPU, memory, and throttle metrics will appear in run detail
charts once the first benchmark run starts.

---

## 10. Verify workers are ready

```bash
kubectl get pods -n omb
```

Look for `omb-worker-0` and `omb-worker-1` in `Running` state with all containers
ready (`1/1` or `2/2` depending on sidecar config):

```
NAME                                          READY   STATUS    RESTARTS   AGE
omb-control-plane-7d9b8f6c4-xk2pq            1/1     Running   0          5m
omb-worker-0                                  1/1     Running   0          5m
omb-worker-1                                  1/1     Running   0          5m
...
```

If a worker is in `CrashLoopBackOff`, check logs:

```bash
kubectl logs omb-worker-0 -n omb
```

The **OMB Cluster** page in the UI also shows a health dot for each worker pod.
A green dot means the worker is reachable and idle. A red dot means the worker
is unreachable — use the restart button (↺) on that row to clear any stuck state.

---

## 11. Run your first benchmark

1. Open the UI at the LoadBalancer hostname from Section 7.
2. Click **New Run** in the left sidebar.
3. Enter a run name (e.g. `acme-baseline-1`).
4. Fill in the **Driver** panel — the cluster connectivity fields are pre-populated
   from Settings; adjust producer/consumer counts and acknowledgements as needed.
5. Fill in the **Workload** panel — set topics, partitions, message size,
   `producerRate`, and duration.
6. Click **Run**.

The page navigates automatically to the run detail view where you can watch live
logs stream and see real-time charts for throughput, latency, and worker resource
usage.

When the run completes, final p50/p99/p999 latency and throughput metrics appear
at the bottom of the page. All results are persisted in SQLite and available in
**Benchmark Runs** for the lifetime of the engagement.

> **Scaling workers:** If you need more throughput, increase the worker count using
> the scaling control at the bottom of the left sidebar. The Cluster Autoscaler
> will add nodes as needed — it does not require any manual intervention.

---

## Teardown

When the engagement is complete:

```bash
helm uninstall omb -n omb
cd terraform/aws
terraform destroy
```

`terraform destroy` takes approximately 10–15 minutes. Confirm all resources are
removed in the AWS console before archiving your state files.
