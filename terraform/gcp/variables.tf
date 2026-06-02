variable "project_id" {
  description = "GCP project ID where all resources will be created"
  type        = string
}

variable "region" {
  description = "GCP region — used for the VPC subnet"
  type        = string
}

variable "zone" {
  description = "GCP zone for the GKE cluster and node pool (e.g. us-central1-a) — single-zone keeps node count predictable and avoids 3x node multiplication of regional clusters"
  type        = string
}

variable "cluster_name" {
  description = "Name of the GKE cluster and related resources. Leave empty to auto-generate as omb-<random-pet>."
  type        = string
  default     = ""
}

variable "subnet_cidr" {
  description = "CIDR for the GKE node subnet — must not overlap with target_cidr. GCP has no VPC-level CIDR; only this subnet needs an address range. Pod IPs use a separate GKE-managed range and do not consume space here, so /24 is sufficient for up to ~250 nodes."
  type        = string
  default     = "10.1.0.0/24"
}

variable "pod_cidr" {
  description = "GKE pod CIDR — must be included in the port-8080 firewall rule so control-plane pods can reach hostNetwork worker pods. GKE routes-based networking defaults to 10.244.0.0/16."
  type        = string
  default     = "10.244.0.0/16"
}

variable "target_network" {
  description = "Self-link of the target VPC to peer with (projects/PROJECT/global/networks/NETWORK); leave empty to skip peering"
  type        = string
  default     = ""
}

variable "target_cidr" {
  description = "CIDR of the target VPC — used in firewall rules when target_network is set"
  type        = string
  default     = ""
}

variable "labels" {
  description = "Labels applied to all resources"
  type        = map(string)
  default     = {}
}
