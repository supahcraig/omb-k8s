# OMB on Kubernetes

A cloud-native benchmarking platform for Redpanda and Kafka-compatible clusters
using the [OpenMessaging Benchmark](https://github.com/redpanda-data/openmessaging-benchmark)
framework. Runs OMB workers as scalable Kubernetes pods, orchestrated through a
control-plane UI. Replaces the previous Terraform + Ansible approach.

The target cluster (Redpanda or Kafka) is always external — this tool benchmarks
existing clusters and never provisions them.

## Overview

![Architecture](docs/architecture.svg)

## Prerequisites

- Terraform >= 1.5
- kubectl >= 1.27
- Helm >= 3.12
- AWS CLI / gcloud / az (depending on cloud)
- Docker (for local worker image builds only)

Cloud credentials configured for your target cloud.

## Quick Start

```bash
# 1. Provision the Kubernetes cluster
cd terraform/aws          # or gcp / azure
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars for the engagement (it is gitignored)
terraform init && terraform apply

# 2. Configure kubectl
$(terraform output -raw kubeconfig_command)

# 3. Install the Helm chart
helm install omb charts/omb -n omb --create-namespace \
  -f charts/omb/values-aws.yaml \
  --set clusterAutoscaler.clusterName=$(terraform output -raw cluster_name) \
  --set clusterAutoscaler.region=$(terraform output -raw region) \
  --set clusterAutoscaler.roleArn=$(terraform output -raw cluster_autoscaler_iam_role_arn)

# 4. Open the UI
kubectl get svc omb-control-plane -n omb -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

Open the LoadBalancer address in your browser. Configure cluster connectivity
and Prometheus in Settings, then run benchmarks.

## Deployment

### AWS (EKS)

```bash
cd terraform/aws
cp terraform.tfvars.example terraform.tfvars
# Edit: cluster_name, region, vpc_cidr, availability_zones, target_vpc_id, target_cidr
terraform init && terraform apply

$(terraform output -raw kubeconfig_command)

helm install omb charts/omb -n omb --create-namespace \
  -f charts/omb/values-aws.yaml \
  --set clusterAutoscaler.clusterName=$(terraform output -raw cluster_name) \
  --set clusterAutoscaler.region=$(terraform output -raw region) \
  --set clusterAutoscaler.roleArn=$(terraform output -raw cluster_autoscaler_iam_role_arn)
```

### GCP (GKE)

```bash
cd terraform/gcp
cp terraform.tfvars.example terraform.tfvars
# Edit: project_id, region, zone, cluster_name, target_network, target_cidr
terraform init && terraform apply

$(terraform output -raw kubeconfig_command)

helm install omb charts/omb -n omb --create-namespace \
  -f charts/omb/values-gcp.yaml
```

### Azure (AKS)

```bash
cd terraform/azure
cp terraform.tfvars.example terraform.tfvars
# Edit: resource_group_name, location, cluster_name, target_vnet_id
terraform init && terraform apply

$(terraform output -raw kubeconfig_command)

helm install omb charts/omb -n omb --create-namespace \
  -f charts/omb/values-aks.yaml
```

### Upgrading

Always supply both `-f` flags explicitly — do not use `--reuse-values`. When a
cloud values file has an explicit entry (e.g. `clusterAutoscaler.region`), it
silently overwrites reused values from the previous install.

```bash
# AWS
helm upgrade omb charts/omb -n omb \
  -f charts/omb/values-aws.yaml \
  --set clusterAutoscaler.clusterName=$(terraform -chdir=terraform/aws output -raw cluster_name) \
  --set clusterAutoscaler.region=$(terraform -chdir=terraform/aws output -raw region) \
  --set clusterAutoscaler.roleArn=$(terraform -chdir=terraform/aws output -raw cluster_autoscaler_iam_role_arn)

# GCP
helm upgrade omb charts/omb -n omb -f charts/omb/values-gcp.yaml

# Azure
helm upgrade omb charts/omb -n omb -f charts/omb/values-aks.yaml
```

### Connecting to a target cluster

**Redpanda Cloud (BYOC):**
- Single bootstrap server
- TLS required
- SASL/SCRAM-SHA-256 required

**Self-hosted:**
- One or more seed brokers (comma-separated)
- TLS and SASL optional

Configure connectivity in the UI under Settings → Cluster Connectivity after
deployment.

## Scaling Workers

Workers are a StatefulSet. Scale them non-destructively through the UI or with
Helm:

```bash
# AWS
helm upgrade omb charts/omb -n omb \
  -f charts/omb/values-aws.yaml \
  --set clusterAutoscaler.clusterName=$(terraform -chdir=terraform/aws output -raw cluster_name) \
  --set clusterAutoscaler.region=$(terraform -chdir=terraform/aws output -raw region) \
  --set clusterAutoscaler.roleArn=$(terraform -chdir=terraform/aws output -raw cluster_autoscaler_iam_role_arn) \
  --set worker.replicas=8
```

Each benchmark-worker node (m5.4xlarge / n2-standard-16 / Standard_D16s_v3)
comfortably fits ~8 worker pods. The Cluster Autoscaler adds nodes automatically
when needed.

Do not change worker instance types or JVM settings to increase throughput.
The correct response to needing more throughput is more worker pods.

## Tearing Down

```bash
# Uninstall the Helm release
helm uninstall omb -n omb

# Destroy the Kubernetes cluster and VPC
cd terraform/<cloud>
terraform destroy
```

**Important:** Terraform state is local. Do not delete your local state
directory until after `terraform destroy` completes successfully.

## Worker Image

See [worker/README.md](worker/README.md) for local build and test instructions.

## Architecture

See [CLAUDE.md](CLAUDE.md) for full architecture documentation and key design
decisions.
