# OMB on Kubernetes

A cloud-native benchmarking platform for Redpanda and Kafka-compatible clusters
using the [OpenMessaging Benchmark](https://github.com/redpanda-data/openmessaging-benchmark)
framework. Runs OMB workers as scalable Kubernetes pods, orchestrated through a
control-plane UI. Replaces the previous Terraform + Ansible approach.

The target cluster (Redpanda or Kafka) is always external — this tool benchmarks
existing clusters and never provisions them.

## Overview

```
┌─────────────────────────────────────────────┐
│  OMB k8s Cluster (EKS/GKE/AKS)             │
│                                             │
│  control-plane pod                          │
│    FastAPI + React UI                       │
│    SQLite on PersistentVolume               │
│                                             │
│  omb-worker pods (StatefulSet, N replicas)  │
│    OMB worker, port 8080                    │
│    Scales non-destructively                 │
│                                             │
│  prometheus + grafana pods                  │
└──────────────────┬──────────────────────────┘
                   │ VPC Peering
┌──────────────────▼──────────────────────────┐
│  Target Cluster (BYOC or self-hosted)       │
│  Redpanda or Kafka-compatible               │
└─────────────────────────────────────────────┘
```

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
cp terraform.tfvars.example ../engagements/<customer>.tfvars
# Edit the tfvars file for the engagement
terraform init && terraform apply -var-file=../engagements/<customer>.tfvars

# 2. Configure kubectl
aws eks update-kubeconfig --name <cluster-name> --region <region>

# 3. Install the Helm chart
helm install omb charts/omb \
  -f charts/omb/values-aws.yaml \
  -f my-values.yaml

# 4. Open the UI
kubectl get svc omb-control-plane -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

Open the LoadBalancer address in your browser. Configure cluster connectivity
and Prometheus in Settings, then run benchmarks.

## Deployment

### AWS (EKS)

```bash
cd terraform/aws
cp terraform.tfvars.example ../engagements/<customer>.tfvars
# Edit: cluster_name, region, vpc_cidr, availability_zones, target_vpc_id, target_cidr
terraform init && terraform apply -var-file=../engagements/<customer>.tfvars
aws eks update-kubeconfig --name <cluster-name> --region <region>
helm install omb charts/omb -f charts/omb/values-aws.yaml -f my-values.yaml
```

### GCP (GKE)

```bash
cd terraform/gcp
cp terraform.tfvars.example ../engagements/<customer>.tfvars
# Edit: project, region, cluster_name, target_network, target_cidr
terraform init && terraform apply -var-file=../engagements/<customer>.tfvars
gcloud container clusters get-credentials <cluster-name> --region <region>
helm install omb charts/omb -f charts/omb/values-gcp.yaml -f my-values.yaml
```

### Azure (AKS)

```bash
cd terraform/azure
cp terraform.tfvars.example ../engagements/<customer>.tfvars
# Edit: resource_group_name, location, cluster_name, target_vnet_id, target_address_space
terraform init && terraform apply -var-file=../engagements/<customer>.tfvars
az aks get-credentials --resource-group <rg> --name <cluster-name>
helm install omb charts/omb -f charts/omb/values-azure.yaml -f my-values.yaml
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
helm upgrade omb charts/omb --reuse-values --set worker.replicas=8
```

Each node (m5.4xlarge / n2-standard-16 / Standard_D16s_v3) comfortably fits
~8 worker pods. The Cluster Autoscaler adds nodes automatically when needed.

Do not change worker instance types or JVM settings to increase throughput.
The correct response to needing more throughput is more worker pods.

## Tearing Down

```bash
# Uninstall the Helm release
helm uninstall omb

# Destroy the Kubernetes cluster and VPC
cd terraform/modules/<cloud>
terraform destroy
```

**Important:** Terraform state is local. Do not delete your local state
directory until after `terraform destroy` completes successfully.

## Worker Image

See [worker/README.md](worker/README.md) for local build and test instructions.

## Architecture

See [CLAUDE.md](CLAUDE.md) for full architecture documentation and key design
decisions.
