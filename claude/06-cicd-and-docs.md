Read CLAUDE.md fully before doing anything else.

This is session 6 of 6. Your deliverables are the control plane CI/CD workflow, 
final documentation, and any cleanup needed across the repo.

## GitHub Actions — control plane workflow

File: .github/workflows/build-control-plane.yml

Triggers:
- Push to main when files under control-plane/ change
- Manual dispatch

Steps:
- Checkout
- Set up Node and build React frontend (output to control-plane/static/)
- Set up Docker Buildx
- Login to ghcr.io using GITHUB_TOKEN
- Build and push image
- Tags: ghcr.io/${{ github.repository_owner }}/omb-control-plane:${{ github.sha }}
  and ghcr.io/${{ github.repository_owner }}/omb-control-plane:latest

Note: the worker workflow already exists from session 1. Do not modify it 
unless there is a bug.

## Documentation

### README.md (root)

Complete the skeleton from session 1. Must include:

- What this is and what problem it solves (2-3 sentences)
- Prerequisites: Docker, Terraform, Helm, kubectl, cloud CLI (aws/gcloud/az), 
  Git. Include minimum version requirements.
- Quick start (abbreviated — points to detailed docs)
- Link to docs/ for detailed guides

### docs/deployment-aws.md
Step by step for EKS. Exact commands. No hand-waving.
Includes: clone repo, configure tfvars, terraform apply, get kubectl credentials, 
helm install, verify deployment, open UI, configure settings.

### docs/deployment-gcp.md
Same for GKE.

### docs/deployment-azure.md
Same for AKS.

### docs/scaling-workers.md
How to scale workers via the UI. When to scale. What to expect (pod startup time, 
readiness indicator). What not to do (don't change instance types, don't tune JVM).

### docs/running-benchmarks.md
SE-focused guide. How to configure cluster connectivity for BYOC vs self-hosted. 
How to use the workload library. How to configure Prometheus. How to run a 
benchmark and interpret results. How to run a parameter sweep.

### docs/teardown.md
Critical doc. Exact steps for clean teardown:
1. Note the LoadBalancer address and any results you want to keep (export instructions)
2. helm uninstall omb
3. terraform destroy
4. Warning: do not delete your local terraform state until after destroy completes
5. Verify in cloud console that all resources are removed (what to check)

### docs/architecture.md
Technical reference. Expand on the architecture section in CLAUDE.md with more detail. 
Include the component diagram. Explain the worker discovery mechanism, 
the ConfigMap pattern for benchmark configs, the in-cluster k8s API access pattern. 
Audience: someone who needs to debug or extend the system.

## Cleanup pass

Review the full repo for:
- Any hardcoded values that should be in values.yaml or env vars
- Any TODO comments that need to be addressed or documented as known limitations
- Consistent naming across Helm chart, Terraform outputs, and k8s resource names
- .gitignore covers all the right things (terraform state files, .env files, 
  node_modules, Python venvs, etc.)

## Validation

1. Both GitHub Actions workflows are syntactically valid (actionlint if available)
2. README renders correctly on GitHub
3. docs/ covers all the scenarios an SE would encounter
4. A hypothetical SE with no prior context on this project could follow 
   docs/deployment-aws.md and get to a running benchmark
