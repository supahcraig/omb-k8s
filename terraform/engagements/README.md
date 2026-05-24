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
