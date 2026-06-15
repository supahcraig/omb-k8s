# terraform

Per-cloud Terraform modules for provisioning EKS/GKE/AKS clusters for the OMB k8s
benchmarking platform. This file supplements the root CLAUDE.md with decisions
specific to this directory.

## Design decisions — do not reverse without discussion

**Terraform state is local.** No remote state backend for Phase 1. SE is
responsible for not deleting their local state until after terraform destroy.
Document this clearly.

**EKS Kubernetes version is not hardcoded.** The `aws_eks_cluster` resource omits
the `version` argument so new clusters always get the latest AWS-supported version.
Do not add a hardcoded version — this caused a production failure when 1.29 AMIs
were retired. If version pinning is ever needed, make it a variable with no default.

**Peering module is three independent sub-modules, not one.** `terraform/modules/peering/`
contains `aws/`, `gcp/`, and `azure/` sub-directories, each independently runnable.
A single module with a `cloud` variable was considered but rejected because Terraform
cannot conditionally initialize providers — all configured providers must be present
regardless of which cloud is active. Do not collapse these into a single module.

**VPC peering uses `auto_accept = true`.** Both the OMB VPC and the Redpanda BYOC VPC
live in the same AWS account (the SE's account), so the peering connection can be
auto-accepted. Do not add a manual acceptance step or `aws_vpc_peering_connection_accepter`
resource — they are not needed for this use case.

**VPC peering route tables are discovered at plan time, not provided in tfvars.** The
`data "aws_route_tables"` data source looks up all route table IDs for a given VPC ID.
Routes are added to all route tables on both sides automatically. Do not reintroduce a
`source_route_table_ids` or `target_route_table_ids` variable — requiring SEs to look up
and manually enter route table IDs is unnecessary toil.

**Redpanda broker security group ID cannot be auto-discovered.** The optional
`target_security_group_id` variable (default "") accepts the SG ID attached to Redpanda
broker nodes. When set, Terraform adds an inbound rule allowing the OMB VPC CIDR on
ports 9092-9093. If omitted, routes work but broker connections will be refused at the SG
layer. This is a known gap — see project memory for the revisit plan.

**EKS Cluster Autoscaler uses IRSA.** The EKS module creates an OIDC provider and
an IAM role for the Cluster Autoscaler via IAM Roles for Service Accounts (IRSA).
The role ARN is exposed as the `cluster_autoscaler_iam_role_arn` output and must
be passed to the Helm chart via `clusterAutoscaler.roleArn`. The Helm chart will
not deploy the Cluster Autoscaler correctly without it.

**EKS node group uses a launch template to attach the OMB workers security group.**
EKS managed node groups don't support attaching additional security groups directly.
The workaround is a launch template that specifies both the cluster-managed security
group (`vpc_config[0].cluster_security_group_id`) and the OMB workers SG (port 9080).
Do not remove the launch template or the node group will lose the port 9080 rules.

**EKS requires the EBS CSI driver addon for PVC provisioning.** The default EKS
setup only has the in-tree `kubernetes.io/aws-ebs` provisioner, which creates a
`gp2` StorageClass. The Helm chart uses `gp3` (cheaper, faster), which requires
the `aws-ebs-csi-driver` EKS addon. The addon is provisioned by the EKS Terraform
module via `aws_eks_addon` with an IRSA role (`ebs-csi-controller-sa` in
`kube-system`). The `gp3` StorageClass itself is created by the Helm chart
(`templates/storageclass-gp3.yaml`), gated on `storage.createStorageClass: true`
in `values-aws.yaml`. Do not remove either — without the addon the StorageClass
exists but PVC provisioning fails; without the StorageClass the PVC stays Pending.

**Azure AKS note:** Renaming `default_node_pool` from `workers` to `controlplane`
forces destruction and recreation of the entire AKS cluster. Re-deploy fresh;
do not attempt in-place upgrade of an existing AKS engagement cluster.

**GKE uses Standard mode, not Autopilot.** `hostNetwork: true` on worker pods
requires Standard mode — Autopilot does not permit hostNetwork. Do not change
`remove_default_node_pool = true` / `initial_node_count = 1` pattern; this is the
correct way to use a separately managed node pool with Standard GKE clusters.

**Cluster names are auto-generated via `random_pet` if not specified.** Each cloud's
Terraform module declares `resource "random_pet" "cluster_suffix" { length = 2 }`.
`var.cluster_name` defaults to `""`. A `locals` block resolves the effective name:
`var.cluster_name != "" ? var.cluster_name : "omb-${random_pet.cluster_suffix.id}"`.
All resource names reference `local.cluster_name`, not `var.cluster_name`. The suffix
is stable across re-applies because Terraform persists it in state. To use a custom
name, set `cluster_name` in terraform.tfvars. Do not reintroduce a required
`cluster_name` variable — name collisions across SEs sharing an AWS account were
the motivation for this change.

**The control-plane LoadBalancer is restricted to `controlPlane.allowedCIDRs`.** The
Helm chart sets `spec.loadBalancerSourceRanges` on the control-plane Service from this
value. Default is `["0.0.0.0/0"]` (open). Each Terraform module outputs
`terraform_operator_ip` (the public IP detected via icanhazip.com at plan time) so the
SE can restrict access at deploy time:
`helm install omb ... --set "controlPlane.allowedCIDRs[0]=$(terraform output -raw terraform_operator_ip)/32"`.
To add IPs post-deploy without redeploying the cluster: `helm upgrade omb charts/omb -n omb
--reuse-values --set "controlPlane.allowedCIDRs[0]=<ip1>/32"`. `loadBalancerSourceRanges`
is honored by AWS (ELB SG rules), GCP (VPC firewall rules), and AKS (NSG rules).

## Reference docs

- `claude/terraform-notes.md` — per-cloud Terraform specifics (additional details)
