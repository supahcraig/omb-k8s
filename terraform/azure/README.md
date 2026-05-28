# terraform/azure — AKS Cluster for OMB Benchmarking

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
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your engagement values (it is gitignored)
```

**2. Initialize and apply:**

```bash
terraform init
terraform plan
terraform apply
```

AKS provisions in ~5-10 minutes.

**3. Configure kubectl:**

```bash
az aks get-credentials --resource-group <resource_group_name> --name <cluster_name>
kubectl get nodes  # should show 4 nodes in Ready state (2 control-plane, 2 benchmark-workers)
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
helm uninstall omb -n omb
terraform destroy
```

Destroying the resource group removes all resources. Verify in the Azure portal.

## Cost note

2× Standard_D4s_v3 (control-plane) + 2× Standard_D16s_v3 (benchmark-workers) costs roughly $2-4/hour while running. Always run
`terraform destroy` at engagement end. `helm uninstall` does not stop the VMs.
