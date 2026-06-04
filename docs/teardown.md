# Engagement Teardown Guide

This guide walks through safely tearing down an omb-k8s engagement to avoid
leaving running cloud resources accruing costs. Follow the steps in order.
Skipping or reordering steps is the most common cause of orphaned infrastructure.

---

## Why this matters

omb-k8s provisions real cloud infrastructure — EKS clusters with EC2 node
groups, GKE clusters with Compute Engine nodes, AKS clusters with virtual
machines, VPCs, VPC peering connections, IAM roles, load balancers, and
persistent disks. None of this stops billing automatically when you are done
benchmarking. `helm uninstall` removes k8s workloads but does **not** terminate
any cloud instances. Only `terraform destroy` terminates the infrastructure.

Terraform state is local. If you delete the state files before running
`terraform destroy`, you will not be able to clean up cloud resources with
Terraform. You would need to manually find and delete every resource in the
cloud console — a tedious and error-prone process.

---

## Step 1 — Export results (before anything else)

Results live in SQLite on a PersistentVolume inside the cluster. There is no
export button in the UI. Once the cluster is gone, results are gone.

**Option A — Screenshot or copy from the UI**

Open the UI at the LoadBalancer address and navigate to each completed run
you want to keep. Screenshot or copy the final metrics (p50/p99 latencies,
throughput, error rate). This is sufficient for most engagements.

**Option B — Copy the database file**

If you need a full backup of all run data, extract the SQLite file before
tearing down:

```bash
# Get the control-plane pod name
POD=$(kubectl get pods -n omb -l app=omb-control-plane \
  -o jsonpath='{.items[0].metadata.name}')

# Copy the database to your local machine
kubectl cp -n omb ${POD}:/data/omb_ui.db ./omb_results_backup.db
```

The database file contains all runs, workload configs, driver configs, sweep
definitions, and Prometheus metric samples for the engagement. Keep it
somewhere safe if the customer may need results revisited later.

---

## Step 2 — Helm uninstall

```bash
helm uninstall omb -n omb
```

This removes all k8s workloads: the control-plane Deployment, worker
StatefulSet, driver Jobs, ConfigMaps, Services, Prometheus, Grafana, and
the Cluster Autoscaler.

> **Important:** `helm uninstall` does NOT terminate cloud instances. EC2
> nodes, GCE nodes, and Azure VMs continue running and billing until
> `terraform destroy` completes.

> **Wait before running terraform destroy.** After `helm uninstall`, AWS needs
> 1–2 minutes to fully deprovision the LoadBalancer services (control plane and
> Grafana). If you run `terraform destroy` immediately, it will fail with
> dependency errors on the VPC subnets while ELB network interfaces are still
> attached. If destroy does fail with a subnet dependency error, wait a minute
> and re-run — do not manually delete resources unless it fails a second time.

**What Helm uninstall does NOT clean up automatically:**

The PersistentVolumeClaim is retained by default to protect data:

```bash
# Delete the PVC only after you have exported any results you need
kubectl delete pvc omb-control-plane-data -n omb
```

The namespace is also retained:

```bash
kubectl delete namespace omb
```

Deleting the namespace is optional — `terraform destroy` will tear down the
entire cluster regardless. Skip it if you are moving straight to Step 3.

---

## Step 3 — terraform destroy

Run `terraform destroy` from the correct cloud directory. This terminates all
cloud infrastructure provisioned during the engagement.

### AWS (EKS)

```bash
cd terraform/aws
terraform destroy
```

Takes approximately 10–15 minutes. AWS destroys resources in dependency order:
node groups first, then the EKS cluster, then VPC peering, then the VPC and
subnets, then IAM roles.

### GCP (GKE)

```bash
cd terraform/gcp
terraform destroy
```

Takes approximately 3–5 minutes.

### Azure (AKS)

```bash
cd terraform/azure
terraform destroy
```

Takes approximately 5–10 minutes.

---

### What `terraform destroy` removes

| Cloud | Resources terminated |
|-------|---------------------|
| AWS | EKS cluster, EC2 node groups, VPC, subnets, internet gateway, NAT gateway, VPC peering connection, route table entries, IAM roles and policies, EBS volumes, load balancer |
| GCP | GKE cluster, Compute Engine node pool instances, VPC network, subnets, VPC peering, firewall rules |
| Azure | AKS cluster, virtual machine scale sets, VNet, subnets, VNet peering, load balancer, managed disks, resource group (if created by Terraform) |

> **If `terraform destroy` reports errors:** Do not re-run destroy blindly.
> Read the error message. Common causes are dependency ordering issues
> (usually resolved by a second `terraform destroy` run) or resources that
> were modified outside of Terraform. Check the cloud console for the
> specific resource and resolve manually if needed.

---

## Step 4 — Verify in the cloud console

After `terraform destroy` reports success, confirm in the cloud console that
no billable resources remain. This takes two minutes and prevents surprise
charges from partially-failed destroys.

### AWS

1. **EC2 → Instances:** No instances in `running` or `stopping` state with
   names matching this engagement. Filter by the `eks:cluster-name` tag if
   needed.
2. **EKS → Clusters:** No cluster named after this engagement.
3. **VPC → Your VPCs:** No VPC tagged or named for this engagement.
4. **VPC → Peering connections:** No `active` or `pending-acceptance` peering
   connection from this engagement's VPC.
5. **EC2 → Load Balancers:** No load balancer created for the omb Service.
6. **EC2 → Elastic Block Store → Volumes:** No orphaned `gp3` volumes in
   `available` state from this engagement.

### GCP

1. **Kubernetes Engine → Clusters:** No cluster for this engagement.
2. **Compute Engine → VM instances:** No node instances with the cluster name
   prefix.
3. **VPC network → VPC networks:** No network for this engagement.
4. **VPC network → VPC network peering:** No active peering entry from this
   engagement.
5. **Compute Engine → Disks:** No persistent disks in `READY` (unattached)
   state from this engagement.

### Azure

1. **Kubernetes services:** No AKS cluster for this engagement.
2. **Resource groups:** The resource group created for this engagement should
   be gone. If it still exists, open it — a non-empty resource group means
   destroy did not fully complete. Check what remains and delete it manually
   or re-run `terraform destroy`.
3. **Virtual networks:** No VNet for this engagement.

---

## Step 5 — Clean up local files

Once `terraform destroy` has completed successfully and you have verified the
cloud console, it is safe to delete local state files.

> **WARNING: Do not delete these files until after `terraform destroy` succeeds.**
> Deleting state before destroy means you cannot use Terraform to clean up
> and must hunt down every resource manually in the cloud console.

Files safe to delete after a confirmed destroy:

```
terraform/aws/terraform.tfvars            # contains sensitive values — delete after destroy
terraform/aws/.terraform/                 # downloaded provider binaries (large, re-downloadable)
terraform/aws/terraform.tfstate           # local state — no longer needed after destroy
terraform/aws/terraform.tfstate.backup    # backup of previous state
terraform/gcp/terraform.tfvars
terraform/gcp/.terraform/
terraform/gcp/terraform.tfstate
terraform/gcp/terraform.tfstate.backup
terraform/azure/terraform.tfvars
terraform/azure/.terraform/
terraform/azure/terraform.tfstate
terraform/azure/terraform.tfstate.backup
```

Also delete the KUBECONFIG file if you exported it to a customer-specific path:

```bash
# If you followed the deployment guide and used a per-engagement kubeconfig:
rm terraform/<cloud>/kubeconfig
unset KUBECONFIG
```

---

## What if I lost the Terraform state?

If you deleted or lost the state file before running `terraform destroy`, you
cannot use Terraform to clean up. You must find and delete resources manually
in the cloud console.

**AWS manual cleanup order** (delete in this order to avoid dependency errors):

1. EKS — delete node groups first, then the cluster
2. EC2 — terminate any remaining instances
3. EC2 → Load Balancers — delete both load balancers (control plane and Grafana)
4. EC2 → EBS Volumes — delete orphaned volumes
5. VPC → Peering connections — delete peering connection
6. VPC → Route tables — remove the peering routes
7. VPC — delete the OMB VPC (will fail until all dependencies above are gone)
8. IAM — delete the IRSA roles for Cluster Autoscaler and EBS CSI driver

**GCP manual cleanup order:**

1. Kubernetes Engine — delete the cluster (this deletes node pools automatically)
2. VPC network — delete peering entries, then delete the network

**Azure manual cleanup order:**

1. Delete the AKS cluster
2. Delete the VNet peering on both sides
3. Delete the resource group

Use resource tags and naming conventions to identify resources belonging to
this engagement. All Terraform-created resources are tagged with the engagement
name by default.
