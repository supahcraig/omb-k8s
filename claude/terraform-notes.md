# Terraform Notes

## General principles

- Each cloud module is independently usable — an SE should be able to run just
  the peering module against an existing cluster
- Modules accept a target_vpc_id and target_cidr variable for peering — they do
  not know or care what kind of cluster is on the other side
- Outputs required from every module: kubeconfig, cluster_endpoint, vpc_id,
  worker_node_role_arn (or equivalent)
- Terraform state is local for Phase 1 — document this clearly in each module's
  README. Do not add remote state backend configuration.

## Instance type selection — why 4xlarge

Worker nodes default to 4xlarge instances across all clouds. This is an
intentional decision for benchmark result fidelity, not a cost decision.

At 4xlarge, cloud providers allocate dedicated network interfaces (ENA on AWS,
vNIC on GCP, NIC on Azure) rather than shared ones. This eliminates network
contention from other VMs on the same physical host — a "noisy neighbor" using
network capacity would directly skew benchmark throughput and latency results.

Combined with hostNetwork: true on worker pods (which bypasses the CNI overlay),
this gives the closest possible approximation to bare metal network performance
within a cloud VM.

Do not downsize these instances to save cost without understanding this tradeoff.
If cost is a concern, reduce the number of worker pods instead.

A 4xlarge node fits approximately 8 worker pods (each requesting 4 vCPU / 8GB)
with headroom remaining for system and monitoring pods.

## AWS (EKS) — primary cloud, get this right first

Key resources:
- VPC with public and private subnets across 2 AZs minimum
- EKS cluster (managed node group)
- Node group instance type: m5.4xlarge (16 vCPU / 64GB)
  Dedicated ENA network interface — eliminates noisy neighbor network contention
- Node group size: min 2, desired 3, max 6
- Cluster Autoscaler enabled on the node group (add the required tags and IAM
  policy so the Cluster Autoscaler deployment in the Helm chart can function)
- Security group rules: allow port 8080 between worker pods, allow control plane
  to reach workers
- VPC peering attachment — accepts peer_vpc_id and peer_vpc_cidr as variables
- Route table entries for peered VPC CIDR on both sides
- IAM role for EKS cluster and node group

StorageClass for PVC: gp3 (preferred over gp2)

Cluster Autoscaler IAM policy must permit:
- autoscaling:DescribeAutoScalingGroups
- autoscaling:DescribeAutoScalingInstances
- autoscaling:DescribeLaunchConfigurations
- autoscaling:DescribeScalingActivities
- autoscaling:DescribeTags
- autoscaling:SetDesiredCapacity
- autoscaling:TerminateInstanceInAutoScalingGroup
- ec2:DescribeImages
- ec2:DescribeInstanceTypes
- ec2:DescribeLaunchTemplateVersions
- ec2:GetInstanceTypesFromInstanceRequirements
- eks:DescribeNodegroup

Node group tags required for Cluster Autoscaler discovery:
- k8s.io/cluster-autoscaler/enabled = true
- k8s.io/cluster-autoscaler/<cluster-name> = owned

Outputs:
- cluster_endpoint
- cluster_name
- kubeconfig (or instructions to run aws eks update-kubeconfig)
- vpc_id
- vpc_cidr

## GCP (GKE)

Key resources:
- VPC (custom mode)
- GKE cluster (Standard, not Autopilot — need hostNetwork support)
- Node pool machine type: n2-standard-16 (16 vCPU / 64GB)
  Dedicated vNIC at this size — eliminates noisy neighbor network contention
- Node pool size: min 2, desired 3, max 6
- Cluster Autoscaler: enable via node pool autoscaling min/max in Terraform
  (GKE manages this natively, no separate deployment needed unlike EKS)
- VPC peering via google_compute_network_peering
- Firewall rules: allow port 8080 between worker nodes

StorageClass for PVC: standard (or premium-rwo for better performance)

Note: GKE is significantly faster to provision than EKS (~3-5 min vs 15-20 min).
GKE also handles Cluster Autoscaler natively — no separate IAM or deployment
required. This is a meaningful operational simplification vs AWS.

Outputs:
- cluster_endpoint
- cluster_name
- kubeconfig
- vpc_id (network self_link)
- vpc_cidr

## Azure (AKS)

Key resources:
- Resource group
- VNet + subnet
- AKS cluster
- Node pool VM size: Standard_D16s_v3 (16 vCPU / 64GB)
  Dedicated NIC allocation at this tier — eliminates noisy neighbor network contention
- Node pool size: min 2, desired 3, max 6
- Cluster Autoscaler: enable via enable_auto_scaling on the node pool in
  Terraform (AKS manages this natively, no separate deployment needed)
- VNet peering via azurerm_virtual_network_peering
- NSG rules: allow port 8080

StorageClass for PVC: managed-premium

Outputs:
- cluster_endpoint
- cluster_name
- kubeconfig (kube_config_raw)
- vpc_id (vnet_id)
- vpc_cidr

## Cluster Autoscaler — AWS only

GKE and AKS handle autoscaling natively via their node pool configuration.
EKS requires a separate Cluster Autoscaler deployment.

Include the Cluster Autoscaler as a component in the Helm chart
(charts/omb/templates/cluster-autoscaler/) enabled only when
values.clusterAutoscaler.enabled is true (default true on AWS, false on GCP/AKS).

The Cluster Autoscaler deployment needs:
- The cluster name (passed via Helm values)
- The AWS region (passed via Helm values)
- The IAM role ARN output from the EKS Terraform module (passed via Helm values)

## Peering module

Standalone module — three sub-directories: terraform/modules/peering/aws|gcp|azure.
Each sub-module accepts the VPC IDs and CIDRs for both sides; route table IDs are
looked up via data source and do not need to be provided in tfvars.

AWS sub-module variables:
- source_vpc_id
- source_vpc_cidr
- target_vpc_id
- target_vpc_cidr
- target_security_group_id (optional — adds inbound rule on 9092-9093 to Redpanda broker SG)
- tags

GCP sub-module variables:
- source_network
- target_network
- tags

Azure sub-module variables:
- resource_group_name
- source_vnet_name
- target_vnet_id
- tags

Used when the k8s cluster already exists and you only need to set up peering
to a new target cluster. Must be independently runnable without the cluster
modules.

Route tables are discovered automatically via `data "aws_route_tables"` keyed on
the VPC ID — routes are added to all route tables on both sides. Do not reintroduce
manual route table ID variables.

## Target cluster types and what peering means for each

**BYOC:** Redpanda deploys into the SE's own AWS account, so both the OMB VPC and
the Redpanda VPC are in the same account. Peering uses `auto_accept = true` — no
manual acceptance step required. The SE provides the target VPC ID and CIDR from
the Redpanda Cloud BYOC UI (Networking tab).

**Self-hosted:** SE owns both VPCs. Peering is fully automated since both sides are
in the same account.

## Per-engagement workflow

Each engagement uses a `terraform.tfvars` file in the cloud directory:

  terraform/<cloud>/terraform.tfvars

This file is gitignored via `*.tfvars` in the root `.gitignore` (the example
file `terraform.tfvars.example` is explicitly un-ignored). SEs copy the example,
fill in engagement-specific values, and never commit the result.

The SE must keep their local terraform state directory until after
terraform destroy completes for the engagement. Document this prominently.

## Cost considerations

The OMB k8s cluster is not cheap while running — 3x m5.4xlarge nodes on AWS
is meaningful spend. Make sure the teardown docs make clear that
terraform destroy is required at engagement end, not just helm uninstall.
helm uninstall removes the k8s workloads but leaves the EC2 instances running.
