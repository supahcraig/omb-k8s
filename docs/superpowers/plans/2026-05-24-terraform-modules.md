# Terraform Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement independently-runnable Terraform modules for EKS, GKE, AKS, and a standalone peering module — each provisioning a k8s cluster for OMB benchmarking with VPC peering to the target Redpanda/Kafka cluster.

**Architecture:** Each cloud module is a root Terraform module (has provider block, can be run directly by an SE). The peering module lives in three sub-directories (one per cloud) since Terraform cannot conditionally initialize providers within a single module. Every module passes `terraform fmt -check`, `terraform init`, and `terraform validate`.

**Tech Stack:** Terraform >= 1.5, AWS provider ~> 5.0 (hashicorp/aws), Google provider ~> 5.0 (hashicorp/google), AzureRM provider ~> 3.0 (hashicorp/azurerm), TLS provider ~> 4.0 (hashicorp/tls, EKS OIDC only)

---

## File Map

```
terraform/
  modules/
    eks/
      versions.tf          provider version constraints + provider block
      variables.tf         all input variables
      vpc.tf               VPC, subnets, IGW, NAT GWs, route tables, VPC peering
      eks.tf               EKS cluster, managed node group, security groups, launch template
      iam.tf               cluster role, node role, autoscaler IRSA role + OIDC provider
      outputs.tf           all required outputs
      terraform.tfvars.example   documented example for SE
      README.md            prerequisites, usage, vars, teardown, cost warning
    gke/
      versions.tf
      variables.tf
      main.tf              all GKE resources (VPC, cluster, node pool, firewall, peering)
      outputs.tf
      terraform.tfvars.example
      README.md
    aks/
      versions.tf
      variables.tf
      main.tf              resource group, VNet, subnet, NSG, AKS cluster, VNet peering
      outputs.tf
      terraform.tfvars.example
      README.md
    peering/
      README.md            explains 3 sub-modules + BYOC handshake docs
      aws/
        versions.tf
        variables.tf
        main.tf            VPC peering connection + route entries
        outputs.tf
        terraform.tfvars.example
      gcp/
        versions.tf
        variables.tf
        main.tf            google_compute_network_peering
        outputs.tf
        terraform.tfvars.example
      azure/
        versions.tf
        variables.tf
        main.tf            azurerm_virtual_network_peering
        outputs.tf
        terraform.tfvars.example
  engagements/
    .gitkeep
    README.md              instructions for SEs managing per-engagement tfvars
```

---

## Task 1: EKS — versions.tf and variables.tf

**Files:**
- Create: `terraform/modules/eks/versions.tf`
- Create: `terraform/modules/eks/variables.tf`

- [ ] **Step 1: Delete the placeholder and create versions.tf**

```hcl
# terraform/modules/eks/versions.tf
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.region
}
```

- [ ] **Step 2: Create variables.tf**

```hcl
# terraform/modules/eks/variables.tf
variable "cluster_name" {
  description = "Name of the EKS cluster and all related AWS resources"
  type        = string
}

variable "region" {
  description = "AWS region to deploy into (e.g. us-east-1)"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the new VPC — must not overlap with target_cidr"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of AZs for subnets — minimum 2 required by EKS"
  type        = list(string)
}

variable "target_vpc_id" {
  description = "VPC ID of the Redpanda/Kafka cluster to peer with; leave empty to skip peering"
  type        = string
  default     = ""
}

variable "target_cidr" {
  description = "CIDR block of the target VPC — required when target_vpc_id is set"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}
```

---

## Task 2: EKS — vpc.tf

**Files:**
- Create: `terraform/modules/eks/vpc.tf`

- [ ] **Step 1: Create vpc.tf**

```hcl
# terraform/modules/eks/vpc.tf
locals {
  public_subnet_cidrs  = [for i, _ in var.availability_zones : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnet_cidrs = [for i, _ in var.availability_zones : cidrsubnet(var.vpc_cidr, 8, i + 10)]
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-vpc"
  })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-igw"
  })
}

resource "aws_subnet" "public" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.public_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  map_public_ip_on_launch = true

  tags = merge(var.tags, {
    Name                                        = "${var.cluster_name}-public-${var.availability_zones[count.index]}"
    "kubernetes.io/role/elb"                    = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  })
}

resource "aws_subnet" "private" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = merge(var.tags, {
    Name                                        = "${var.cluster_name}-private-${var.availability_zones[count.index]}"
    "kubernetes.io/role/internal-elb"           = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  })
}

resource "aws_eip" "nat" {
  count  = length(var.availability_zones)
  domain = "vpc"

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-nat-eip-${count.index}"
  })
}

resource "aws_nat_gateway" "main" {
  count         = length(var.availability_zones)
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-nat-${var.availability_zones[count.index]}"
  })

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-public-rt"
  })
}

resource "aws_route_table_association" "public" {
  count          = length(var.availability_zones)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = length(var.availability_zones)
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-private-rt-${var.availability_zones[count.index]}"
  })
}

resource "aws_route_table_association" "private" {
  count          = length(var.availability_zones)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

resource "aws_vpc_peering_connection" "target" {
  count = var.target_vpc_id != "" ? 1 : 0

  vpc_id      = aws_vpc.main.id
  peer_vpc_id = var.target_vpc_id

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-to-target"
  })
}

resource "aws_route" "to_target" {
  count = var.target_vpc_id != "" ? length(var.availability_zones) : 0

  route_table_id            = aws_route_table.private[count.index].id
  destination_cidr_block    = var.target_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.target[0].id
}
```

---

## Task 3: EKS — eks.tf

**Files:**
- Create: `terraform/modules/eks/eks.tf`

- [ ] **Step 1: Create eks.tf**

```hcl
# terraform/modules/eks/eks.tf
resource "aws_security_group" "omb_workers" {
  name        = "${var.cluster_name}-omb-workers"
  description = "Additional SG for OMB worker port 8080 communication"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "OMB worker-to-worker on port 8080"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-omb-workers"
  })
}

resource "aws_eks_cluster" "main" {
  name     = var.cluster_name
  role_arn = aws_iam_role.eks_cluster.arn
  version  = "1.29"

  vpc_config {
    subnet_ids              = aws_subnet.private[*].id
    endpoint_private_access = true
    endpoint_public_access  = true
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_cluster_policy,
  ]

  tags = var.tags
}

resource "aws_launch_template" "workers" {
  name_prefix = "${var.cluster_name}-workers-"
  instance_type = "m5.4xlarge"

  vpc_security_group_ids = [
    aws_eks_cluster.main.vpc_config[0].cluster_security_group_id,
    aws_security_group.omb_workers.id,
  ]

  tag_specifications {
    resource_type = "instance"
    tags = merge(var.tags, {
      Name = "${var.cluster_name}-worker"
    })
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_eks_node_group" "workers" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.cluster_name}-workers"
  node_role_arn   = aws_iam_role.node_group.arn
  subnet_ids      = aws_subnet.private[*].id

  launch_template {
    id      = aws_launch_template.workers.id
    version = aws_launch_template.workers.latest_version
  }

  scaling_config {
    desired_size = 3
    min_size     = 2
    max_size     = 6
  }

  update_config {
    max_unavailable = 1
  }

  # Required tags for Cluster Autoscaler node group discovery
  tags = merge(var.tags, {
    "k8s.io/cluster-autoscaler/enabled"             = "true"
    "k8s.io/cluster-autoscaler/${var.cluster_name}" = "owned"
  })

  depends_on = [
    aws_iam_role_policy_attachment.node_group_worker,
    aws_iam_role_policy_attachment.node_group_cni,
    aws_iam_role_policy_attachment.node_group_ecr,
  ]
}
```

---

## Task 4: EKS — iam.tf

**Files:**
- Create: `terraform/modules/eks/iam.tf`

Note: `iam.tf` references `aws_eks_cluster.main` (defined in `eks.tf`) for the OIDC provider. Terraform resolves cross-file references automatically within the same module directory.

- [ ] **Step 1: Create iam.tf**

```hcl
# terraform/modules/eks/iam.tf
data "aws_caller_identity" "current" {}

# ── EKS cluster role ──────────────────────────────────────────────────────────

data "aws_iam_policy_document" "eks_cluster_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "eks_cluster" {
  name               = "${var.cluster_name}-eks-cluster-role"
  assume_role_policy = data.aws_iam_policy_document.eks_cluster_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "eks_cluster_policy" {
  role       = aws_iam_role.eks_cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

# ── Node group role ───────────────────────────────────────────────────────────

data "aws_iam_policy_document" "node_group_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node_group" {
  name               = "${var.cluster_name}-node-group-role"
  assume_role_policy = data.aws_iam_policy_document.node_group_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "node_group_worker" {
  role       = aws_iam_role.node_group.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_group_cni" {
  role       = aws_iam_role.node_group.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "node_group_ecr" {
  role       = aws_iam_role.node_group.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# ── OIDC provider (required for IRSA) ────────────────────────────────────────

data "tls_certificate" "eks" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
  tags            = var.tags
}

# ── Cluster Autoscaler IRSA role ──────────────────────────────────────────────

locals {
  oidc_issuer = replace(aws_eks_cluster.main.identity[0].oidc[0].issuer, "https://", "")
}

data "aws_iam_policy_document" "cluster_autoscaler_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:sub"
      values   = ["system:serviceaccount:kube-system:cluster-autoscaler"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "cluster_autoscaler" {
  statement {
    actions = [
      "autoscaling:DescribeAutoScalingGroups",
      "autoscaling:DescribeAutoScalingInstances",
      "autoscaling:DescribeLaunchConfigurations",
      "autoscaling:DescribeScalingActivities",
      "autoscaling:DescribeTags",
      "autoscaling:SetDesiredCapacity",
      "autoscaling:TerminateInstanceInAutoScalingGroup",
      "ec2:DescribeImages",
      "ec2:DescribeInstanceTypes",
      "ec2:DescribeLaunchTemplateVersions",
      "ec2:GetInstanceTypesFromInstanceRequirements",
      "eks:DescribeNodegroup",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "cluster_autoscaler" {
  name        = "${var.cluster_name}-cluster-autoscaler"
  description = "IAM policy for EKS Cluster Autoscaler"
  policy      = data.aws_iam_policy_document.cluster_autoscaler.json
  tags        = var.tags
}

resource "aws_iam_role" "cluster_autoscaler" {
  name               = "${var.cluster_name}-cluster-autoscaler"
  assume_role_policy = data.aws_iam_policy_document.cluster_autoscaler_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "cluster_autoscaler" {
  role       = aws_iam_role.cluster_autoscaler.name
  policy_arn = aws_iam_policy.cluster_autoscaler.arn
}
```

---

## Task 5: EKS — outputs.tf and terraform.tfvars.example

**Files:**
- Create: `terraform/modules/eks/outputs.tf`
- Create: `terraform/modules/eks/terraform.tfvars.example`

- [ ] **Step 1: Create outputs.tf**

```hcl
# terraform/modules/eks/outputs.tf
output "cluster_endpoint" {
  description = "EKS cluster API server endpoint"
  value       = aws_eks_cluster.main.endpoint
}

output "cluster_name" {
  description = "EKS cluster name"
  value       = aws_eks_cluster.main.name
}

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "VPC CIDR block"
  value       = aws_vpc.main.cidr_block
}

output "private_subnet_ids" {
  description = "Private subnet IDs (used by Helm chart)"
  value       = aws_subnet.private[*].id
}

output "node_role_arn" {
  description = "IAM role ARN for worker nodes"
  value       = aws_iam_role.node_group.arn
}

output "cluster_autoscaler_iam_role_arn" {
  description = "IAM role ARN for the Cluster Autoscaler — pass to Helm chart via clusterAutoscaler.roleArn"
  value       = aws_iam_role.cluster_autoscaler.arn
}

output "vpc_peering_connection_id" {
  description = "VPC peering connection ID — share with Redpanda BYOC to accept the peering request"
  value       = length(aws_vpc_peering_connection.target) > 0 ? aws_vpc_peering_connection.target[0].id : ""
}

output "kubeconfig_command" {
  description = "Run this command to configure kubectl after apply"
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${var.cluster_name}"
}
```

- [ ] **Step 2: Create terraform.tfvars.example**

```hcl
# terraform/modules/eks/terraform.tfvars.example
# Copy this file to terraform/engagements/<customer>.tfvars and fill in values.
# NEVER commit the filled-in copy — it contains sensitive infrastructure details.

# Unique name for this engagement's cluster and all related AWS resources.
# Use something like "omb-<customer>-<YYYYMMDD>" to avoid name collisions.
cluster_name = "omb-acme-20240101"

# AWS region where the k8s cluster will be created.
# This should be the same region (or a peered region) as the target Redpanda cluster.
region = "us-east-1"

# CIDR block for the new VPC.
# Must not overlap with target_cidr or any other VPC in this AWS account.
vpc_cidr = "10.0.0.0/16"

# At least two AZs in the same region. EKS requires multi-AZ for the control plane.
availability_zones = ["us-east-1a", "us-east-1b"]

# VPC ID of the Redpanda/Kafka cluster you will benchmark.
# For BYOC: copy this from the Redpanda Cloud BYOC UI (Networking tab).
# For self-hosted: the VPC ID where your brokers run.
# Leave empty ("") to provision the cluster without VPC peering.
target_vpc_id = "vpc-0123456789abcdef0"

# CIDR block of the target VPC above.
target_cidr = "172.16.0.0/16"

# Tags applied to every AWS resource in this module.
tags = {
  project    = "omb-benchmarking"
  customer   = "acme"
  managed_by = "terraform"
}
```

---

## Task 6: EKS — validate

**Files:** All files in `terraform/modules/eks/` (read-only in this step)

- [ ] **Step 1: Remove the .gitkeep placeholder**

```bash
rm terraform/modules/eks/.gitkeep
```

- [ ] **Step 2: Auto-format all files**

```bash
cd terraform/modules/eks && terraform fmt
```

Expected: list of files reformatted (or no output if already correct)

- [ ] **Step 3: Initialize the module**

```bash
cd terraform/modules/eks && terraform init -upgrade
```

Expected: output ending with "Terraform has been successfully initialized!"

- [ ] **Step 4: Validate the configuration**

```bash
cd terraform/modules/eks && terraform validate
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 5: Confirm fmt-check passes**

```bash
cd terraform/modules/eks && terraform fmt -check
```

Expected: exit code 0 (no output)

---

## Task 7: EKS — README.md

**Files:**
- Create: `terraform/modules/eks/README.md`

- [ ] **Step 1: Create README.md**

```markdown
# terraform/modules/eks — EKS Cluster for OMB Benchmarking

Provisions an EKS cluster with VPC, node group, IAM roles, and optional VPC peering
to the target Redpanda/Kafka cluster. Terraform state is stored locally — **do not
delete your state directory until after `terraform destroy` completes.**

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Terraform | >= 1.5 | https://developer.hashicorp.com/terraform/install |
| AWS CLI | >= 2.x | https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |
| kubectl | >= 1.28 | https://kubernetes.io/docs/tasks/tools/ |

AWS credentials must be configured (`aws configure` or environment variables).
The IAM principal used needs permissions to create VPCs, EKS clusters, IAM roles,
and EC2 resources.

## Usage — fresh engagement

**1. Create your tfvars file (never commit this):**

```bash
cp terraform.tfvars.example ../../engagements/<customer>.tfvars
# Edit the file with your engagement-specific values
```

**2. Initialize and apply:**

```bash
terraform init
terraform plan -var-file=../../engagements/<customer>.tfvars
terraform apply -var-file=../../engagements/<customer>.tfvars
```

Expect ~15-20 minutes for EKS to provision.

**3. Configure kubectl:**

```bash
aws eks update-kubeconfig --region <region> --name <cluster_name>
kubectl get nodes  # should show 3 nodes in Ready state
```

**4. Note the Cluster Autoscaler role ARN from outputs:**

```bash
terraform output cluster_autoscaler_iam_role_arn
```

Pass this to the Helm chart as `--set clusterAutoscaler.roleArn=<arn>`.

**5. If using BYOC: complete the peering handshake**

After apply, the VPC peering connection will be in `pending-acceptance` state.
Share the `vpc_peering_connection_id` output value with your Redpanda contact.
They must accept it from the BYOC UI before traffic can flow to the brokers.

```bash
terraform output vpc_peering_connection_id
```

## Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `cluster_name` | yes | — | Unique name for this engagement's cluster |
| `region` | yes | — | AWS region |
| `availability_zones` | yes | — | List of AZs (minimum 2) |
| `vpc_cidr` | no | `10.0.0.0/16` | CIDR for the new VPC — must not overlap with target |
| `target_vpc_id` | no | `""` | VPC ID of target cluster; leave empty to skip peering |
| `target_cidr` | no | `""` | CIDR of target VPC; required when `target_vpc_id` is set |
| `tags` | no | `{}` | Tags applied to all resources |

## Outputs

| Output | Description |
|--------|-------------|
| `cluster_endpoint` | EKS API server URL |
| `cluster_name` | Cluster name (pass to Helm) |
| `vpc_id` | VPC ID |
| `vpc_cidr` | VPC CIDR |
| `private_subnet_ids` | Private subnet IDs |
| `node_role_arn` | Worker node IAM role ARN |
| `cluster_autoscaler_iam_role_arn` | Autoscaler IRSA role ARN (pass to Helm) |
| `vpc_peering_connection_id` | Peering connection ID to share with BYOC |
| `kubeconfig_command` | Ready-to-run `aws eks update-kubeconfig` command |

## Teardown

**Important:** `helm uninstall` removes k8s workloads but leaves EC2 instances running.
You must run `terraform destroy` to stop incurring costs.

```bash
helm uninstall omb -n default
terraform destroy -var-file=../../engagements/<customer>.tfvars
```

Destroy takes ~10-15 minutes. Verify in the AWS console that the EKS cluster, VPC,
and NAT gateways are gone before closing the engagement.

Keep your `terraform.tfstate` file until destroy completes. Without it you cannot
clean up cloud resources cleanly and will need to delete them manually.

## Cost note

3× m5.4xlarge nodes on AWS costs roughly $3–5/hour while running. Always run
`terraform destroy` at engagement end. The m5.4xlarge size is intentional —
at this instance class AWS allocates dedicated ENA network interfaces, which
eliminates noisy-neighbor network contention and ensures benchmark results
reflect actual cluster performance.
```

---

## Task 8: EKS — commit

- [ ] **Step 1: Stage and commit**

```bash
git add terraform/modules/eks/
git commit -m "feat(terraform): add EKS module with VPC, node group, and autoscaler IRSA"
```

---

## Task 9: GKE — all files

**Files:**
- Create: `terraform/modules/gke/versions.tf`
- Create: `terraform/modules/gke/variables.tf`
- Create: `terraform/modules/gke/main.tf`
- Create: `terraform/modules/gke/outputs.tf`
- Create: `terraform/modules/gke/terraform.tfvars.example`

- [ ] **Step 1: Remove the .gitkeep placeholder**

```bash
rm terraform/modules/gke/.gitkeep
```

- [ ] **Step 2: Create versions.tf**

```hcl
# terraform/modules/gke/versions.tf
terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
```

- [ ] **Step 3: Create variables.tf**

```hcl
# terraform/modules/gke/variables.tf
variable "project_id" {
  description = "GCP project ID where all resources will be created"
  type        = string
}

variable "region" {
  description = "GCP region (cluster is regional, spanning all zones in the region)"
  type        = string
}

variable "cluster_name" {
  description = "Name of the GKE cluster and related resources"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR for the VPC subnet — must not overlap with target_cidr"
  type        = string
  default     = "10.1.0.0/16"
}

variable "target_network" {
  description = "Self-link of the target VPC to peer with (projects/PROJECT/global/networks/NETWORK); leave empty to skip peering"
  type        = string
  default     = ""
}

variable "target_cidr" {
  description = "CIDR of the target VPC — used in firewall rules when target_network is set"
  type        = string
  default     = ""
}

variable "labels" {
  description = "Labels applied to all resources"
  type        = map(string)
  default     = {}
}
```

- [ ] **Step 4: Create main.tf**

```hcl
# terraform/modules/gke/main.tf
resource "google_compute_network" "main" {
  name                    = "${var.cluster_name}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  name          = "${var.cluster_name}-subnet"
  ip_cidr_range = var.vpc_cidr
  region        = var.region
  network       = google_compute_network.main.id
}

resource "google_container_cluster" "main" {
  name     = var.cluster_name
  location = var.region

  # Remove default node pool immediately; manage nodes via google_container_node_pool
  remove_default_node_pool = true
  initial_node_count       = 1

  network    = google_compute_network.main.name
  subnetwork = google_compute_subnetwork.main.name

  # Standard mode required for hostNetwork: true on pods
  deletion_protection = false
}

resource "google_container_node_pool" "workers" {
  name     = "${var.cluster_name}-workers"
  location = var.region
  cluster  = google_container_cluster.main.name

  initial_node_count = 3

  autoscaling {
    min_node_count = 2
    max_node_count = 6
  }

  node_config {
    machine_type = "n2-standard-16"
    disk_size_gb = 100
    disk_type    = "pd-ssd"

    # Cloud platform scope required for GKE to manage nodes
    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    labels = var.labels

    metadata = {
      disable-legacy-endpoints = "true"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

resource "google_compute_network_peering" "to_target" {
  count = var.target_network != "" ? 1 : 0

  name         = "${var.cluster_name}-to-target"
  network      = google_compute_network.main.self_link
  peer_network = var.target_network
}

resource "google_compute_firewall" "omb_workers_8080" {
  name    = "${var.cluster_name}-omb-8080"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }

  # Allow intra-subnet (worker-to-worker) and from peered target if configured
  source_ranges = compact([
    var.vpc_cidr,
    var.target_cidr,
  ])
}
```

- [ ] **Step 5: Create outputs.tf**

```hcl
# terraform/modules/gke/outputs.tf
output "cluster_endpoint" {
  description = "GKE cluster master endpoint"
  value       = "https://${google_container_cluster.main.endpoint}"
}

output "cluster_name" {
  description = "GKE cluster name"
  value       = google_container_cluster.main.name
}

output "vpc_id" {
  description = "VPC network self_link"
  value       = google_compute_network.main.self_link
}

output "vpc_cidr" {
  description = "VPC subnet CIDR"
  value       = google_compute_subnetwork.main.ip_cidr_range
}

output "kubeconfig_command" {
  description = "Run this command to configure kubectl after apply"
  value       = "gcloud container clusters get-credentials ${var.cluster_name} --region ${var.region} --project ${var.project_id}"
}
```

- [ ] **Step 6: Create terraform.tfvars.example**

```hcl
# terraform/modules/gke/terraform.tfvars.example
# Copy to terraform/engagements/<customer>.tfvars. NEVER commit the filled-in copy.

# GCP project where all resources will be created.
project_id = "my-gcp-project-id"

# GCP region. The cluster will be regional (nodes in all zones in this region).
region = "us-central1"

# Short descriptive name. Used as prefix for all resource names.
cluster_name = "omb-acme-20240101"

# CIDR for the new VPC subnet. Must not overlap with the target cluster.
vpc_cidr = "10.1.0.0/16"

# Network self_link of the Redpanda/Kafka cluster VPC to peer with.
# Format: projects/PROJECT_ID/global/networks/NETWORK_NAME
# For BYOC: obtain from the Redpanda Cloud BYOC UI (Networking tab).
# Leave empty ("") to skip VPC peering.
target_network = "projects/redpanda-project-id/global/networks/redpanda-vpc"
target_cidr    = "172.16.0.0/16"

labels = {
  project    = "omb-benchmarking"
  customer   = "acme"
  managed-by = "terraform"
}
```

---

## Task 10: GKE — validate

- [ ] **Step 1: Auto-format**

```bash
cd terraform/modules/gke && terraform fmt
```

- [ ] **Step 2: Initialize**

```bash
cd terraform/modules/gke && terraform init -upgrade
```

Expected: "Terraform has been successfully initialized!"

- [ ] **Step 3: Validate**

```bash
cd terraform/modules/gke && terraform validate
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 4: Confirm fmt-check**

```bash
cd terraform/modules/gke && terraform fmt -check
```

Expected: exit code 0

---

## Task 11: GKE — README.md and commit

**Files:**
- Create: `terraform/modules/gke/README.md`

- [ ] **Step 1: Create README.md**

```markdown
# terraform/modules/gke — GKE Cluster for OMB Benchmarking

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
cp terraform.tfvars.example ../../engagements/<customer>.tfvars
# Edit with your engagement values
```

**2. Initialize and apply:**

```bash
terraform init
terraform plan -var-file=../../engagements/<customer>.tfvars
terraform apply -var-file=../../engagements/<customer>.tfvars
```

GKE provisions in ~3-5 minutes (significantly faster than EKS).

**3. Configure kubectl:**

```bash
gcloud container clusters get-credentials <cluster_name> --region <region> --project <project_id>
kubectl get nodes  # should show 3 nodes in Ready state
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
terraform destroy -var-file=../../engagements/<customer>.tfvars
```

## Cost note

3× n2-standard-16 nodes in GCP costs roughly $2-4/hour while running. Always
run `terraform destroy` at engagement end. `helm uninstall` does not stop the nodes.
```

- [ ] **Step 2: Commit**

```bash
git add terraform/modules/gke/
git commit -m "feat(terraform): add GKE module with VPC, node pool, and native autoscaling"
```

---

## Task 12: AKS — all files

**Files:**
- Create: `terraform/modules/aks/versions.tf`
- Create: `terraform/modules/aks/variables.tf`
- Create: `terraform/modules/aks/main.tf`
- Create: `terraform/modules/aks/outputs.tf`
- Create: `terraform/modules/aks/terraform.tfvars.example`

- [ ] **Step 1: Remove the .gitkeep placeholder**

```bash
rm terraform/modules/aks/.gitkeep
```

- [ ] **Step 2: Create versions.tf**

```hcl
# terraform/modules/aks/versions.tf
terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}
```

- [ ] **Step 3: Create variables.tf**

```hcl
# terraform/modules/aks/variables.tf
variable "resource_group_name" {
  description = "Name of the Azure resource group to create for this engagement"
  type        = string
}

variable "location" {
  description = "Azure region (e.g. eastus, westus2, eastus2)"
  type        = string
}

variable "cluster_name" {
  description = "Name of the AKS cluster and related resources"
  type        = string
}

variable "vnet_address_space" {
  description = "Address space for the new VNet — must not overlap with target VNet"
  type        = list(string)
  default     = ["10.2.0.0/16"]
}

variable "subnet_address_prefix" {
  description = "Address prefix for the AKS node subnet"
  type        = string
  default     = "10.2.0.0/20"
}

variable "target_vnet_id" {
  description = "Resource ID of the target Redpanda/Kafka VNet to peer with; leave empty to skip peering"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}
```

- [ ] **Step 4: Create main.tf**

```hcl
# terraform/modules/aks/main.tf
resource "azurerm_resource_group" "main" {
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

resource "azurerm_virtual_network" "main" {
  name                = "${var.cluster_name}-vnet"
  address_space       = var.vnet_address_space
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}

resource "azurerm_subnet" "aks" {
  name                 = "${var.cluster_name}-aks-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [var.subnet_address_prefix]
}

resource "azurerm_network_security_group" "omb_workers" {
  name                = "${var.cluster_name}-omb-nsg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags

  security_rule {
    name                       = "allow-omb-8080-inbound"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "8080"
    source_address_prefix      = var.subnet_address_prefix
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "aks" {
  subnet_id                 = azurerm_subnet.aks.id
  network_security_group_id = azurerm_network_security_group.omb_workers.id
}

resource "azurerm_kubernetes_cluster" "main" {
  name                = var.cluster_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = var.cluster_name
  tags                = var.tags

  default_node_pool {
    name                = "workers"
    vm_size             = "Standard_D16s_v3"
    min_count           = 2
    max_count           = 6
    node_count          = 3
    enable_auto_scaling = true
    vnet_subnet_id      = azurerm_subnet.aks.id

    node_labels = {
      role = "omb-worker"
    }
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin = "azure"
    service_cidr   = "10.100.0.0/16"
    dns_service_ip = "10.100.0.10"
  }
}

resource "azurerm_virtual_network_peering" "to_target" {
  count = var.target_vnet_id != "" ? 1 : 0

  name                      = "${var.cluster_name}-to-target"
  resource_group_name       = azurerm_resource_group.main.name
  virtual_network_name      = azurerm_virtual_network.main.name
  remote_virtual_network_id = var.target_vnet_id
  allow_forwarded_traffic   = true
}
```

- [ ] **Step 5: Create outputs.tf**

```hcl
# terraform/modules/aks/outputs.tf
output "cluster_endpoint" {
  description = "AKS cluster API server URL"
  value       = azurerm_kubernetes_cluster.main.kube_config[0].host
}

output "cluster_name" {
  description = "AKS cluster name"
  value       = azurerm_kubernetes_cluster.main.name
}

output "vpc_id" {
  description = "VNet resource ID"
  value       = azurerm_virtual_network.main.id
}

output "vpc_cidr" {
  description = "VNet address space (first range)"
  value       = azurerm_virtual_network.main.address_space[0]
}

output "kubeconfig" {
  description = "Raw kubeconfig content (sensitive)"
  value       = azurerm_kubernetes_cluster.main.kube_config_raw
  sensitive   = true
}

output "kubeconfig_command" {
  description = "Run this command to configure kubectl after apply"
  value       = "az aks get-credentials --resource-group ${var.resource_group_name} --name ${var.cluster_name}"
}
```

- [ ] **Step 6: Create terraform.tfvars.example**

```hcl
# terraform/modules/aks/terraform.tfvars.example
# Copy to terraform/engagements/<customer>.tfvars. NEVER commit the filled-in copy.

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

---

## Task 13: AKS — validate

- [ ] **Step 1: Auto-format**

```bash
cd terraform/modules/aks && terraform fmt
```

- [ ] **Step 2: Initialize**

```bash
cd terraform/modules/aks && terraform init -upgrade
```

Expected: "Terraform has been successfully initialized!"

- [ ] **Step 3: Validate**

```bash
cd terraform/modules/aks && terraform validate
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 4: Confirm fmt-check**

```bash
cd terraform/modules/aks && terraform fmt -check
```

Expected: exit code 0

---

## Task 14: AKS — README.md and commit

**Files:**
- Create: `terraform/modules/aks/README.md`

- [ ] **Step 1: Create README.md**

```markdown
# terraform/modules/aks — AKS Cluster for OMB Benchmarking

Provisions an AKS cluster with VNet, subnet, NSG rules, and optional VNet peering to
the target Redpanda/Kafka cluster. Cluster Autoscaler is managed natively by AKS via
`enable_auto_scaling` on the node pool — no separate deployment required.

Terraform state is stored locally — **do not delete your state directory until after
`terraform destroy` completes.**

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Terraform | >= 1.5 | https://developer.hashicorp.com/terraform/install |
| Azure CLI | >= 2.50 | https://docs.microsoft.com/en-us/cli/azure/install-azure-cli |
| kubectl | >= 1.28 | https://kubernetes.io/docs/tasks/tools/ |

Authenticate before running: `az login`

## Usage — fresh engagement

**1. Create your tfvars file (never commit this):**

```bash
cp terraform.tfvars.example ../../engagements/<customer>.tfvars
# Edit with your engagement values
```

**2. Initialize and apply:**

```bash
terraform init
terraform plan -var-file=../../engagements/<customer>.tfvars
terraform apply -var-file=../../engagements/<customer>.tfvars
```

AKS provisions in ~5-10 minutes.

**3. Configure kubectl:**

```bash
az aks get-credentials --resource-group <resource_group_name> --name <cluster_name>
kubectl get nodes  # should show 3 nodes in Ready state
```

**4. If using BYOC: complete the peering handshake**

Azure VNet peering requires both sides to create a peering. After apply, your
side is created. Share your VNet ID with your Redpanda contact:

```bash
terraform output vpc_id
```

They must create a reverse peering from their VNet to yours via the BYOC UI.

## Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `resource_group_name` | yes | — | Azure resource group name |
| `location` | yes | — | Azure region |
| `cluster_name` | yes | — | Cluster name prefix |
| `vnet_address_space` | no | `["10.2.0.0/16"]` | VNet address space |
| `subnet_address_prefix` | no | `10.2.0.0/20` | AKS node subnet prefix |
| `target_vnet_id` | no | `""` | Target VNet resource ID; leave empty to skip peering |
| `tags` | no | `{}` | Tags for all resources |

## Outputs

| Output | Description |
|--------|-------------|
| `cluster_endpoint` | AKS API server URL |
| `cluster_name` | Cluster name (pass to Helm) |
| `vpc_id` | VNet resource ID (share with BYOC for peering) |
| `vpc_cidr` | VNet address space |
| `kubeconfig` | Raw kubeconfig (sensitive — use `az aks get-credentials` instead) |
| `kubeconfig_command` | Ready-to-run `az aks get-credentials` command |

## Teardown

```bash
helm uninstall omb -n default
terraform destroy -var-file=../../engagements/<customer>.tfvars
```

Destroying the resource group removes all resources. Verify in the Azure portal.

## Cost note

3× Standard_D16s_v3 nodes costs roughly $2-4/hour while running. Always run
`terraform destroy` at engagement end. `helm uninstall` does not stop the VMs.
```

- [ ] **Step 2: Commit**

```bash
git add terraform/modules/aks/
git commit -m "feat(terraform): add AKS module with VNet, node pool, and native autoscaling"
```

---

## Task 15: Peering — AWS sub-module

**Files:**
- Create: `terraform/modules/peering/aws/versions.tf`
- Create: `terraform/modules/peering/aws/variables.tf`
- Create: `terraform/modules/peering/aws/main.tf`
- Create: `terraform/modules/peering/aws/outputs.tf`
- Create: `terraform/modules/peering/aws/terraform.tfvars.example`

- [ ] **Step 1: Remove the .gitkeep placeholder from the peering directory**

```bash
rm terraform/modules/peering/.gitkeep
mkdir -p terraform/modules/peering/aws terraform/modules/peering/gcp terraform/modules/peering/azure
```

- [ ] **Step 2: Create aws/versions.tf**

```hcl
# terraform/modules/peering/aws/versions.tf
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}
```

- [ ] **Step 3: Create aws/variables.tf**

```hcl
# terraform/modules/peering/aws/variables.tf
variable "region" {
  description = "AWS region where the source VPC lives"
  type        = string
}

variable "source_vpc_id" {
  description = "VPC ID of the OMB cluster (peering initiator)"
  type        = string
}

variable "source_vpc_cidr" {
  description = "CIDR block of the OMB cluster VPC"
  type        = string
}

variable "source_route_table_ids" {
  description = "List of route table IDs in the OMB VPC to add peering routes to (typically the private route tables)"
  type        = list(string)
}

variable "target_vpc_id" {
  description = "VPC ID of the target Redpanda/Kafka cluster"
  type        = string
}

variable "target_vpc_cidr" {
  description = "CIDR block of the target cluster VPC"
  type        = string
}

variable "tags" {
  description = "Tags applied to peering resources"
  type        = map(string)
  default     = {}
}
```

- [ ] **Step 4: Create aws/main.tf**

```hcl
# terraform/modules/peering/aws/main.tf
resource "aws_vpc_peering_connection" "main" {
  vpc_id      = var.source_vpc_id
  peer_vpc_id = var.target_vpc_id

  tags = merge(var.tags, {
    Name = "omb-to-target-peering"
  })
}

resource "aws_route" "to_target" {
  count = length(var.source_route_table_ids)

  route_table_id            = var.source_route_table_ids[count.index]
  destination_cidr_block    = var.target_vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.main.id
}
```

- [ ] **Step 5: Create aws/outputs.tf**

```hcl
# terraform/modules/peering/aws/outputs.tf
output "peering_connection_id" {
  description = "VPC peering connection ID — share with Redpanda BYOC to accept"
  value       = aws_vpc_peering_connection.main.id
}

output "peering_status" {
  description = "Current status: pending-acceptance (BYOC) or active (self-hosted same account)"
  value       = aws_vpc_peering_connection.main.accept_status
}
```

- [ ] **Step 6: Create aws/terraform.tfvars.example**

```hcl
# terraform/modules/peering/aws/terraform.tfvars.example
# Use this module when the OMB k8s cluster already exists and you need to set up
# or re-establish peering to a new or changed target cluster.

region = "us-east-1"

# From: terraform output vpc_id (in the EKS module)
source_vpc_id = "vpc-0aaa111bbb222ccc3"

# From: terraform output vpc_cidr (in the EKS module)
source_vpc_cidr = "10.0.0.0/16"

# From: terraform output private_subnet_ids -> look up their route tables, OR
# use the AWS console: VPC > Route Tables > filter by VPC ID > copy IDs of private RTs
source_route_table_ids = [
  "rtb-0aaa111bbb222ccc3",
  "rtb-0ddd444eee555fff6",
]

# VPC ID of the Redpanda/Kafka cluster to benchmark.
# For BYOC: from the Redpanda Cloud BYOC UI (Networking tab).
target_vpc_id = "vpc-0123456789abcdef0"

# CIDR of the target VPC.
target_vpc_cidr = "172.16.0.0/16"

tags = {
  project    = "omb-benchmarking"
  managed_by = "terraform"
}
```

---

## Task 16: Peering — GCP sub-module

**Files:**
- Create: `terraform/modules/peering/gcp/versions.tf`
- Create: `terraform/modules/peering/gcp/variables.tf`
- Create: `terraform/modules/peering/gcp/main.tf`
- Create: `terraform/modules/peering/gcp/outputs.tf`
- Create: `terraform/modules/peering/gcp/terraform.tfvars.example`

- [ ] **Step 1: Create gcp/versions.tf**

```hcl
# terraform/modules/peering/gcp/versions.tf
terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
}
```

- [ ] **Step 2: Create gcp/variables.tf**

```hcl
# terraform/modules/peering/gcp/variables.tf
variable "project_id" {
  description = "GCP project ID of the OMB cluster"
  type        = string
}

variable "source_network" {
  description = "Self-link of the OMB cluster VPC network (projects/PROJECT/global/networks/NETWORK)"
  type        = string
}

variable "target_network" {
  description = "Self-link of the target Redpanda/Kafka network"
  type        = string
}
```

- [ ] **Step 3: Create gcp/main.tf**

```hcl
# terraform/modules/peering/gcp/main.tf
resource "google_compute_network_peering" "omb_to_target" {
  name         = "omb-to-target"
  network      = var.source_network
  peer_network = var.target_network
}
```

- [ ] **Step 4: Create gcp/outputs.tf**

```hcl
# terraform/modules/peering/gcp/outputs.tf
output "peering_name" {
  description = "Name of the network peering resource"
  value       = google_compute_network_peering.omb_to_target.name
}

output "peering_state" {
  description = "Current state: ACTIVE (both sides created) or INACTIVE (waiting for peer)"
  value       = google_compute_network_peering.omb_to_target.state
}
```

- [ ] **Step 5: Create gcp/terraform.tfvars.example**

```hcl
# terraform/modules/peering/gcp/terraform.tfvars.example
# GCP peering requires BOTH sides to create a peering resource.
# This module creates the OMB side. Redpanda must create the reverse peering.

# GCP project ID of the OMB cluster.
project_id = "my-gcp-project-id"

# From: terraform output vpc_id (in the GKE module)
source_network = "projects/my-gcp-project-id/global/networks/omb-acme-20240101-vpc"

# From the Redpanda Cloud BYOC UI (Networking tab).
# Format: projects/PROJECT_ID/global/networks/NETWORK_NAME
target_network = "projects/redpanda-project-id/global/networks/redpanda-vpc"
```

---

## Task 17: Peering — Azure sub-module

**Files:**
- Create: `terraform/modules/peering/azure/versions.tf`
- Create: `terraform/modules/peering/azure/variables.tf`
- Create: `terraform/modules/peering/azure/main.tf`
- Create: `terraform/modules/peering/azure/outputs.tf`
- Create: `terraform/modules/peering/azure/terraform.tfvars.example`

- [ ] **Step 1: Create azure/versions.tf**

```hcl
# terraform/modules/peering/azure/versions.tf
terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}
```

- [ ] **Step 2: Create azure/variables.tf**

```hcl
# terraform/modules/peering/azure/variables.tf
variable "resource_group_name" {
  description = "Resource group containing the OMB cluster VNet"
  type        = string
}

variable "source_vnet_name" {
  description = "Name of the OMB cluster VNet"
  type        = string
}

variable "source_vnet_id" {
  description = "Resource ID of the OMB cluster VNet"
  type        = string
}

variable "target_vnet_id" {
  description = "Resource ID of the target Redpanda/Kafka VNet"
  type        = string
}
```

- [ ] **Step 3: Create azure/main.tf**

```hcl
# terraform/modules/peering/azure/main.tf
resource "azurerm_virtual_network_peering" "omb_to_target" {
  name                      = "omb-to-target"
  resource_group_name       = var.resource_group_name
  virtual_network_name      = var.source_vnet_name
  remote_virtual_network_id = var.target_vnet_id
  allow_forwarded_traffic   = true
}
```

- [ ] **Step 4: Create azure/outputs.tf**

```hcl
# terraform/modules/peering/azure/outputs.tf
output "peering_id" {
  description = "Resource ID of the VNet peering"
  value       = azurerm_virtual_network_peering.omb_to_target.id
}

output "peering_provisioning_state" {
  description = "Provisioning state: Succeeded, Updating, or Failed"
  value       = azurerm_virtual_network_peering.omb_to_target.peering_sync_level
}
```

- [ ] **Step 5: Create azure/terraform.tfvars.example**

```hcl
# terraform/modules/peering/azure/terraform.tfvars.example
# Azure VNet peering requires BOTH sides to create a peering resource.
# This module creates the OMB side. Redpanda must create the reverse peering.

# Resource group of the OMB cluster VNet.
resource_group_name = "omb-acme-20240101-rg"

# From: the cluster_name variable used in the AKS module (VNet is named <cluster_name>-vnet)
source_vnet_name = "omb-acme-20240101-vnet"

# From: terraform output vpc_id (in the AKS module)
source_vnet_id = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/omb-acme-20240101-rg/providers/Microsoft.Network/virtualNetworks/omb-acme-20240101-vnet"

# From the Redpanda Cloud BYOC UI (Networking tab).
target_vnet_id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/redpanda-rg/providers/Microsoft.Network/virtualNetworks/redpanda-vnet"
```

---

## Task 18: Peering — validate all sub-modules and README

**Files:**
- Create: `terraform/modules/peering/README.md`

- [ ] **Step 1: Validate AWS peering sub-module**

```bash
cd terraform/modules/peering/aws && terraform fmt && terraform init -upgrade && terraform validate && terraform fmt -check
```

Expected: each command succeeds; final `fmt -check` exits 0

- [ ] **Step 2: Validate GCP peering sub-module**

```bash
cd terraform/modules/peering/gcp && terraform fmt && terraform init -upgrade && terraform validate && terraform fmt -check
```

- [ ] **Step 3: Validate Azure peering sub-module**

```bash
cd terraform/modules/peering/azure && terraform fmt && terraform init -upgrade && terraform validate && terraform fmt -check
```

- [ ] **Step 4: Create peering/README.md**

```markdown
# terraform/modules/peering — Standalone VPC Peering

Use this module to establish (or re-establish) VPC peering between an existing OMB
k8s cluster and a target Redpanda/Kafka cluster. It is independently runnable —
the cluster modules do not need to be in the same Terraform state.

Three sub-modules, one per cloud:

| Cloud | Directory |
|-------|-----------|
| AWS   | `aws/`    |
| GCP   | `gcp/`    |
| Azure | `azure/`  |

Each sub-module is independently initialized and applied.

---

## BYOC peering handshake (required for Redpanda Cloud BYOC clusters)

**This is a two-step process. You cannot complete it alone.**

For BYOC clusters, Redpanda manages the target VPC. Peering must be accepted
from the Redpanda Cloud UI:

1. You run `terraform apply` in the appropriate sub-module.
2. A peering request is initiated from the OMB side. It will be in
   `pending-acceptance` (AWS) or `INACTIVE` (GCP/Azure) state.
3. Share the peering ID/connection name with your Redpanda contact.
4. They accept (or create the reverse peering for GCP/Azure) from the BYOC UI.
5. The connection becomes `active` / `ACTIVE` — traffic can now flow.

For **self-hosted** clusters where you own both VPCs, you can typically complete
both sides yourself using the same or a second Terraform configuration.

---

## AWS usage

```bash
cd aws/
cp terraform.tfvars.example ../../../engagements/<customer>-peering-aws.tfvars
# Fill in source_vpc_id, source_route_table_ids, target_vpc_id, target_vpc_cidr
terraform init
terraform apply -var-file=../../../engagements/<customer>-peering-aws.tfvars
terraform output peering_connection_id   # share this with Redpanda BYOC
```

**Finding source_route_table_ids:** These are the private route table IDs from the
EKS module's VPC. Get them from:
```bash
# In the EKS module directory:
terraform show | grep route_table
# Or from AWS console: VPC > Route Tables > filter by VPC ID
```

## GCP usage

```bash
cd gcp/
cp terraform.tfvars.example ../../../engagements/<customer>-peering-gcp.tfvars
terraform init
terraform apply -var-file=../../../engagements/<customer>-peering-gcp.tfvars
terraform output peering_state   # INACTIVE until Redpanda creates reverse peering
```

GCP peering requires both sides. The peering will show `INACTIVE` until Redpanda
creates a reverse peering from their network to yours. Share your `source_network`
self_link (from `terraform output vpc_id` in the GKE module) with your Redpanda contact.

## Azure usage

```bash
cd azure/
cp terraform.tfvars.example ../../../engagements/<customer>-peering-azure.tfvars
terraform init
terraform apply -var-file=../../../engagements/<customer>-peering-azure.tfvars
```

Azure VNet peering requires both sides. Share your `source_vnet_id` (from
`terraform output vpc_id` in the AKS module) with your Redpanda contact.
```

- [ ] **Step 5: Commit**

```bash
git add terraform/modules/peering/
git commit -m "feat(terraform): add per-cloud peering sub-modules with BYOC handshake docs"
```

---

## Task 19: Engagements directory

**Files:**
- Verify: `terraform/engagements/` is in `.gitignore` (already present)
- Update: `.gitignore` to allow README.md in the engagements directory
- Create: `terraform/engagements/README.md`

- [ ] **Step 1: Add .gitignore exception for README.md in engagements**

The current `.gitignore` has `terraform/engagements/` which excludes everything.
Add an exception so the README and .gitkeep can be tracked:

In `.gitignore`, find the line `terraform/engagements/` and update the block to:

```
# Per-engagement Terraform working directories are intentionally excluded from
# version control. SEs create these for each customer engagement, and they
# contain sensitive variables (broker addresses, credentials, account IDs) that
# must not be committed. Each SE manages their own state locally and is
# responsible for running terraform destroy before deleting their state.
terraform/engagements/
!terraform/engagements/.gitkeep
!terraform/engagements/README.md
```

- [ ] **Step 2: Create terraform/engagements/README.md**

```markdown
# terraform/engagements/

This directory holds per-customer `.tfvars` files. **Files here are gitignored and
must never be committed.**

## Creating a new engagement

Copy the example from the appropriate cloud module:

```bash
# AWS
cp ../modules/eks/terraform.tfvars.example ./<customer>-aws.tfvars

# GCP
cp ../modules/gke/terraform.tfvars.example ./<customer>-gcp.tfvars

# Azure
cp ../modules/aks/terraform.tfvars.example ./<customer>-aks.tfvars
```

Then edit the file with your engagement-specific values: cluster name, region,
broker VPC ID, CIDR, and tags.

## Running an engagement

From the appropriate cloud module directory:

```bash
cd ../modules/eks/   # or gke/ or aks/
terraform init
terraform apply -var-file=../../engagements/<customer>.tfvars
```

## Critical: keep your state until destroy completes

Terraform stores resource state in `terraform.tfstate` in whichever directory
you run it from. This state file maps Terraform resource blocks to real cloud
resources. **If you delete the state file before running `terraform destroy`,
you lose the ability to clean up cloud resources through Terraform** — you
would need to delete them manually from the cloud console, which is error-prone
and risks leaving expensive resources running.

**Keep your entire module directory (including `.terraform/` and `terraform.tfstate`)
until `terraform destroy` has completed successfully and you have verified in the
cloud console that all resources are gone.**

## What lives here

- `<customer>.tfvars` — engagement-specific variable values
- Nothing else — no state files, no lock files, no generated configs

State files live in the module directory (`modules/eks/terraform.tfstate`, etc.)
because that is where you run `terraform apply` and `terraform destroy`.
```

- [ ] **Step 3: Commit**

```bash
git add terraform/engagements/ .gitignore
git commit -m "feat(terraform): add engagements directory with per-engagement workflow docs"
```

---

## Self-Review Checklist

**Spec coverage:**

| Requirement | Task |
|-------------|------|
| EKS module independently usable | Task 1–8 |
| EKS variables.tf, outputs.tf, main.tf (split into multiple files) | Task 1–5 |
| EKS accepts target_vpc_id + target_cidr | Task 1, 2 |
| EKS outputs: cluster_endpoint, cluster_name, vpc_id, vpc_cidr | Task 5 |
| EKS Cluster Autoscaler IAM + node tags | Task 3, 4 |
| EKS autoscaler role ARN output | Task 5 |
| EKS terraform.tfvars.example documented | Task 5 |
| EKS README with commands | Task 7 |
| GKE module independently usable | Task 9–11 |
| GKE native autoscaling (min/max in node pool) | Task 9 |
| GKE Standard mode (not Autopilot, needed for hostNetwork) | Task 9 |
| AKS module independently usable | Task 12–14 |
| AKS native autoscaling | Task 12 |
| Peering module standalone + independently runnable | Task 15–18 |
| Peering BYOC handshake documented | Task 18 |
| terraform/engagements/.gitkeep in .gitignore | Task 19 |
| terraform/engagements/README.md | Task 19 |
| All modules pass fmt + init + validate | Tasks 6, 10, 13, 18 |

**No placeholders found:** All tasks contain complete HCL code, no TODOs or TBDs.

**Type/name consistency:** `aws_eks_cluster.main` referenced in both `eks.tf` (definition) and `iam.tf` (OIDC issuer reference) — consistent. Output names match across module descriptions. StorageClass names not in scope for Terraform modules (those go in Helm values files).
