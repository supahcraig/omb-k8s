# Session 2 — Terraform Modules

Read CLAUDE.md and claude/terraform-notes.md fully before doing anything else.

This is session 2 of 6. Your deliverable is working Terraform modules for
EKS, GKE, AKS, and a standalone peering module.

Build EKS first and get it fully working before touching GKE or AKS. The
patterns established in the EKS module should be consistent across all three.

## Requirements for all modules

Refer to claude/terraform-notes.md for per-cloud specifics including instance
types, StorageClass names, node pool sizing, dedicated NIC rationale, and
peering approach.

Each module must:
- Be independently usable with its own variables.tf, outputs.tf, main.tf
- Accept target_vpc_id and target_cidr as variables for VPC peering to the
  target Redpanda/Kafka cluster
- Output: cluster_endpoint, cluster_name, vpc_id, vpc_cidr
- Include a terraform.tfvars.example with all required variables documented
  and commented
- Include a README.md with: prerequisites, usage, variable reference, and
  the exact commands an SE would run for a fresh engagement from
  terraform init through getting kubectl credentials

## Cluster Autoscaler

AWS (EKS) requires explicit Cluster Autoscaler support:
- Add the required IAM policy and node group tags documented in
  claude/terraform-notes.md
- Output the autoscaler IAM role ARN so it can be passed to the Helm chart

GKE and AKS handle autoscaling natively via node pool min/max configuration
in Terraform — no extra IAM or deployment required for those clouds.

## Peering module

terraform/modules/peering/ must be standalone and independently runnable
without the cluster modules. See claude/terraform-notes.md for full variable
requirements and per-cloud peering implementation details.

Include clear documentation of the BYOC peering handshake — the SE initiates
the peering request from the OMB side, but Redpanda must accept it from the
BYOC UI. This is a step the SE cannot complete alone and must be called out
explicitly in the module README.

## Engagements directory

- Create terraform/engagements/.gitkeep
- Confirm terraform/engagements/ is in .gitignore
- Add terraform/engagements/README.md explaining:
  - Create a .tfvars file here per customer engagement
  - Never commit these files (customer infrastructure details)
  - Keep this directory and its contents until after terraform destroy
    completes for the engagement — losing state means losing the ability
    to clean up cloud resources cleanly

## Validation

Each module must pass:
  terraform init
  terraform validate
  terraform fmt -check

Include in each module's README the exact commands to go from zero to a
running cluster with kubectl configured, and the exact commands for teardown.

Do not build the Helm chart or touch the control plane. That is sessions 3 and 4.
