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
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars for the engagement (it is gitignored)
terraform init && terraform apply

# 2. Configure kubectl
aws eks update-kubeconfig --name <cluster-name> --region <region>

# 3. Create your my-values.yaml (see section below)

# 4. Install the Helm chart
helm install omb charts/omb \
  -f charts/omb/values-aws.yaml \
  -f my-values.yaml

# 5. Open the UI
kubectl get svc omb-control-plane -n omb -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

Open the LoadBalancer address in your browser. Configure cluster connectivity
and Prometheus in Settings, then run benchmarks.

## my-values.yaml

Create this file before running `helm install`. It is gitignored and holds
engagement-specific values that must not be committed.

```yaml
# Generate with:
# python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
# Required — without this, saved SASL/Prometheus passwords are lost on pod restart.
controlPlane:
  encryptionKey: "<base64-encoded Fernet key>"

# Required for EKS — values come from terraform output
clusterAutoscaler:
  enabled: true
  clusterName: "<cluster-name>"
  region: "<aws-region>"
  roleArn: "<cluster-autoscaler-iam-role-arn>"
```

The Fernet key is stored in a Kubernetes Secret and mounted into the control plane
pod. It encrypts SASL passwords and Prometheus credentials at rest in SQLite.
Rotate it by updating `my-values.yaml` and running `helm upgrade` — any previously
saved passwords will need to be re-entered in Settings.

## Deployment

### AWS (EKS)

```bash
cd terraform/aws
cp terraform.tfvars.example terraform.tfvars
# Edit: cluster_name, region, vpc_cidr, availability_zones, target_vpc_id, target_cidr
terraform init && terraform apply
aws eks update-kubeconfig --name <cluster-name> --region <region>
# Set controlPlane.encryptionKey and clusterAutoscaler values in my-values.yaml first
helm install omb charts/omb -n omb --create-namespace -f charts/omb/values-aws.yaml -f my-values.yaml
```

### GCP (GKE)

```bash
cd terraform/gcp
cp terraform.tfvars.example terraform.tfvars
# Edit: project_id, region, zone, cluster_name, target_network, target_cidr
terraform init && terraform apply
gcloud container clusters get-credentials <cluster-name> --region <region>
# Set controlPlane.encryptionKey in my-values.yaml first
helm install omb charts/omb -n omb --create-namespace -f charts/omb/values-gcp.yaml -f my-values.yaml
```

### Azure (AKS)

```bash
cd terraform/azure
cp terraform.tfvars.example terraform.tfvars
# Edit: resource_group_name, location, cluster_name, target_vnet_id
terraform init && terraform apply
az aks get-credentials --resource-group <rg> --name <cluster-name>
# Set controlPlane.encryptionKey in my-values.yaml first
helm install omb charts/omb -n omb --create-namespace -f charts/omb/values-azure.yaml -f my-values.yaml
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
