# terraform/aws — EKS Cluster for OMB Benchmarking

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
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your engagement-specific values (it is gitignored)
```

**2. Initialize and apply:**

```bash
terraform init
terraform plan
terraform apply
```

Expect ~15-20 minutes for EKS to provision.

**3. Configure kubectl:**

```bash
aws eks update-kubeconfig --region <region> --name <cluster_name>
kubectl get nodes  # should show 4 nodes in Ready state (2 control-plane, 2 benchmark-workers)
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
helm uninstall omb -n omb
terraform destroy
```

Destroy takes ~10-15 minutes. Verify in the AWS console that the EKS cluster, VPC,
and NAT gateways are gone before closing the engagement.

Keep your `terraform.tfstate` file until destroy completes. Without it you cannot
clean up cloud resources cleanly and will need to delete them manually.

## Cost note

2× m5.xlarge control-plane nodes + 2× m5.4xlarge benchmark-worker nodes on AWS costs roughly $3–5/hour while running. Always run
`terraform destroy` at engagement end. The m5.4xlarge size is intentional —
at this instance class AWS allocates dedicated ENA network interfaces, which
eliminates noisy-neighbor network contention and ensures benchmark results
reflect actual cluster performance.
