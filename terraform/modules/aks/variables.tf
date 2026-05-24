variable "resource_group_name" {
  description = "Name of the Azure resource group to create for this engagement"
  type        = string
}

variable "location" {
  description = "Azure region (e.g. eastus, westus2, eastus2)"
  type        = string
}

variable "cluster_name" {
  description = "Name of the AKS cluster and related resources"
  type        = string
}

variable "vnet_address_space" {
  description = "Address space for the new VNet — must not overlap with target VNet"
  type        = list(string)
  default     = ["10.2.0.0/16"]
}

variable "subnet_address_prefix" {
  description = "Address prefix for the AKS node subnet"
  type        = string
  default     = "10.2.0.0/20"
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
