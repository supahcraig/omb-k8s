variable "resource_group_name" {
  description = "Name of the Azure resource group to create for this engagement"
  type        = string
}

variable "location" {
  description = "Azure region (e.g. eastus, westus2, eastus2)"
  type        = string
}

variable "cluster_name" {
  description = "Name of the AKS cluster and related resources. Leave empty to auto-generate as omb-<random-pet>."
  type        = string
  default     = ""
}

variable "vnet_address_space" {
  description = "Address space for the new VNet — must not overlap with target VNet. Must be at least as large as subnet_address_prefix."
  type        = list(string)
  default     = ["10.2.0.0/22"]
}

variable "subnet_address_prefix" {
  description = "Address prefix for the AKS node subnet. Azure CNI pre-allocates max_pods IPs per node regardless of actual pod count (default max_pods=30). At full scale (22 nodes × 30) = 660+ IPs needed — /22 (1019 usable) is the minimum safe size."
  type        = string
  default     = "10.2.0.0/22"
}

variable "target_vnet_id" {
  description = "Resource ID of the target Redpanda/Kafka VNet to peer with; leave empty to skip peering"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}
