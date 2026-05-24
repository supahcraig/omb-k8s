# Session 6 — CI/CD + Docs

Read CLAUDE.md fully before doing anything else.

This is session 6 of 6. Your deliverables are the control plane CI/CD
workflow, final documentation, and a cleanup pass across the entire repo.

## GitHub Actions — control plane workflow

File: .github/workflows/build-control-plane.yml

Triggers:
- Push to main when files under control-plane/ change
- Manual dispatch

Steps:
- Checkout
- Set up Node and build React frontend (output to control-plane/frontend/dist/
  or build/ — match whatever the frontend build outputs)
- Set up Docker Buildx
- Login to ghcr.io using GITHUB_TOKEN
- Build and push image
- Tags:
    ghcr.io/${{ github.repository_owner }}/omb-control-plane:${{ github.sha }}
    ghcr.io/${{ github.repository_owner }}/omb-control-plane:latest

The worker workflow already exists from session 1. Do not modify it unless
you find a bug.

## Documentation

### README.md (root)

Complete the skeleton from session 1. Must include:

- What this is and what problem it solves (2-3 sentences, no jargon)
- Prerequisites with minimum version requirements:
    Terraform >= 1.5
    Helm >= 3.12
    kubectl >= 1.27
    Docker >= 24
    AWS CLI / gcloud / az (as appropriate)
    Git
- Quick Start section (abbreviated, points to docs/ for detail)
- Links to all docs/ guides

### docs/deployment-aws.md

Step by step for EKS. Exact commands. No hand-waving. An SE with no prior
context on this project must be able to follow this document and reach a
running benchmark.

Sections:
1. Prerequisites (AWS CLI configured, kubectl installed, Helm installed)
2. Clone the repo
3. Create your engagement tfvars file (with example content)
4. Run Terraform (exact commands, what to expect, how long it takes)
5. Configure kubectl credentials (exact aws eks update-kubeconfig command
   using Terraform outputs)
6. Run Helm install (exact command with values-aws.yaml)
7. Get the UI address (exact kubectl command)
8. Configure cluster connectivity in the UI (BYOC and self-hosted paths)
9. Configure Prometheus in the UI
10. Verify workers are ready
11. Run your first benchmark

Include a note on EKS provisioning time (~15-20 minutes) so SEs know
what to expect and don't assume something is broken.

### docs/deployment-gcp.md

Same structure as deployment-aws.md for GKE.
Note that GKE provisions significantly faster (~3-5 minutes).

### docs/deployment-azure.md

Same structure for AKS.

### docs/scaling-workers.md

Audience: SE mid-engagement who needs more throughput.

Cover:
- How to scale via the UI scaling control
- What happens when you scale up (pod startup, readiness indicator,
  when it is safe to run)
- What happens when you scale beyond current node capacity
  (Cluster Autoscaler adds a node, ~2-3 minutes)
- What NOT to do: do not change instance types, do not modify JVM settings,
  do not edit the Helm chart to change pod resource limits
- The correct mental model: more pods = more throughput, not bigger pods

### docs/running-benchmarks.md

Audience: SE running a customer engagement. Practical, task-oriented.

Cover:
- Configuring cluster connectivity for BYOC vs self-hosted (with screenshots
  or ASCII diagrams of the settings screen)
- Using the workload library: selecting bundled workloads, cloning and
  customizing, creating from scratch
- Running a single benchmark: what to fill in, what the results mean
- Running a parameter sweep: when to use it, how to configure it,
  how to compare sweep results
- Configuring Prometheus: BYOC path vs self-hosted path
- Interpreting results: key metrics (throughput, p99 latency, p999 latency),
  what good looks like, common failure patterns

### docs/teardown.md

This is a critical document. Incomplete teardown leaves running EC2 instances
and accruing costs.

Exact teardown steps:
1. Export any results you want to keep (explain how — screenshot, export
   button if one exists, or note that results are lost on teardown)
2. helm uninstall omb -n <namespace>
   Note: this stops workloads but does NOT terminate EC2 instances
3. terraform destroy
   This terminates all cloud resources including EC2 nodes, VPC, peering
4. Verify in the cloud console that all resources are removed
   (what to check per cloud — EC2 console, VPC console, EKS console)
5. Warning: do not delete your local terraform state directory until after
   destroy completes — losing state means you cannot cleanly destroy
   cloud resources and will need to manually hunt them down in the console

### docs/architecture.md

Technical reference for someone who needs to debug or extend the system.

Cover:
- Component diagram (expand on the one in CLAUDE.md)
- Worker discovery mechanism — why StatefulSet, how DNS names are constructed,
  how the control plane builds the --workers argument
- Benchmark run lifecycle — from UI click to Job completion, step by step
- ConfigMap pattern for benchmark configs — creation, mounting, cleanup
- In-cluster k8s API access — ServiceAccount, Role, how credentials are
  injected automatically
- SQLite on PersistentVolume — why not Postgres, what survives pod restarts,
  what does not
- VPC peering topology — why the OMB cluster and target cluster are in
  separate VPCs, what peering means for each cloud
- Worker JVM configuration — why settings are fixed, what the flags do,
  why horizontal scaling is preferred over vertical

## Cleanup pass

Review the full repo before considering this session complete:

- No hardcoded values that should be in values.yaml or env vars
- No TODO comments that are unaddressed — either fix them or document them
  as known limitations in a KNOWN_ISSUES.md
- Consistent naming across Helm chart resource names, Terraform outputs,
  k8s resource names, and env var names
- .gitignore covers: terraform state files (*.tfstate, *.tfstate.backup,
  .terraform/), .env files, node_modules/, Python venvs (venv/, .venv/),
  __pycache__/, *.pyc, .DS_Store, terraform/engagements/
- Every README.md in every subdirectory is accurate and complete
- charts/omb/README.md includes the full validation checklist from session 3

## Final validation

1. Both GitHub Actions workflows are syntactically valid
   (run actionlint if available, otherwise yamllint)
2. README.md renders correctly — check heading hierarchy, code blocks,
   and links
3. docs/deployment-aws.md is complete enough that an SE with no prior
   context could follow it start to finish
4. terraform validate passes on all three cloud modules and the peering module
5. helm lint charts/omb passes
