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
