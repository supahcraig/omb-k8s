# terraform/gcp — GKE Cluster for OMB Benchmarking

Provisions a regional GKE cluster (Standard mode) with VPC, node pool, and optional
VPC peering to the target Redpanda/Kafka cluster. Cluster Autoscaler is managed
natively by GKE — no separate deployment required.

Terraform state is stored locally — **do not delete your state directory until after
`terraform destroy` completes.**

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Terraform | >= 1.5 | https://developer.hashicorp.com/terraform/install |
| gcloud CLI | >= 450 | https://cloud.google.com/sdk/docs/install |
| kubectl | >= 1.28 | https://kubernetes.io/docs/tasks/tools/ |

Authenticate before running: `gcloud auth application-default login`

## Usage — fresh engagement

**1. Create your tfvars file (never commit this):**

```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your engagement values (it is gitignored)
```

**2. Initialize and apply:**

```bash
terraform init
terraform plan
terraform apply
```

GKE provisions in ~3-5 minutes (significantly faster than EKS).

**3. Configure kubectl:**

```bash
gcloud container clusters get-credentials <cluster_name> --region <region> --project <project_id>
kubectl get nodes  # should show 4 nodes in Ready state (2 control-plane, 2 benchmark-workers)
```

**4. If using BYOC: complete the peering handshake**

GCP VPC peering requires both sides to initiate. After apply, the peering will be
`INACTIVE` until Redpanda creates the reverse peering from their side. Share
your network self_link with your Redpanda contact:

```bash
terraform output vpc_id
```

They must create a peering from their network to yours via the BYOC UI.

## Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `project_id` | yes | — | GCP project ID |
| `region` | yes | — | GCP region |
| `cluster_name` | yes | — | Cluster name prefix |
| `vpc_cidr` | no | `10.1.0.0/16` | Subnet CIDR |
| `target_network` | no | `""` | Target network self_link; leave empty to skip peering |
| `target_cidr` | no | `""` | Target CIDR for firewall rules |
| `labels` | no | `{}` | Labels for all resources |

## Outputs

| Output | Description |
|--------|-------------|
| `cluster_endpoint` | GKE master endpoint URL |
| `cluster_name` | Cluster name (pass to Helm) |
| `vpc_id` | Network self_link (share with BYOC for peering) |
| `vpc_cidr` | Subnet CIDR |
| `kubeconfig_command` | Ready-to-run `gcloud` credentials command |

## Teardown

```bash
helm uninstall omb -n default
terraform destroy
```

## Cost note

2× n2-standard-4 (control-plane) + 2× n2-standard-16 (benchmark-workers) nodes in GCP costs roughly $2-4/hour while running. Always
run `terraform destroy` at engagement end. `helm uninstall` does not stop the nodes.
