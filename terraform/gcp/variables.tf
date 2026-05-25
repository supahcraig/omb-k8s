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
  description = "Name of the GKE cluster and related resources"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR for the VPC subnet — must not overlap with target_cidr"
  type        = string
  default     = "10.1.0.0/16"
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
