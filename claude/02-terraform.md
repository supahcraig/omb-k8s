Read CLAUDE.md and claude/terraform-notes.md fully before doing anything else.

This is session 2 of 6. Your deliverable is working Terraform modules for 
EKS, GKE, AKS, and a standalone peering module.

Build EKS first and get it fully working before touching GKE or AKS. The 
patterns established in the EKS module should be consistent across all three.

## Requirements for all modules

Refer to claude/terraform-notes.md for per-cloud specifics including instance 
types, StorageClass names, node pool sizing, and peering approach.

Each module must:
- Be independently runnable with its own variables.tf, outputs.tf, main.tf
- Accept target_vpc_id and target_cidr as variables for peering
- Output: cluster_endpoint, cluster_name, vpc_id, vpc_cidr
- Include a terraform.tfvars.example with all required variables documented
- Include a README.md with: prerequisites, usage, variable reference, 
  how to connect kubectl after apply

## Peering module

terraform/modules/peering/ must be standalone and work independently of the 
cluster modules. See claude/terraform-notes.md for variable requirements.

## Engagements directory

Create terraform/engagements/.gitkeep and confirm terraform/engagements/ is 
in .gitignore. Add a README.md to terraform/engagements/ explaining:
- Create a .tfvars file here per customer engagement
- Never commit these files (they contain customer infrastructure details)
- Keep this file until after terraform destroy for the engagement

## Validation

Each module should be syntactically valid (terraform validate passes) and 
follow current Terraform best practices (terraform fmt passes).

Include in each module's README the exact commands an SE would run for a 
fresh engagement, from terraform init through getting kubectl credentials.

Do not build the Helm chart or touch the control plane. That is session 3 and 4.
