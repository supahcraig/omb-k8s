variable "resource_group_name" {
  description = "Resource group containing the OMB cluster VNet"
  type        = string
}

variable "source_vnet_name" {
  description = "Name of the OMB cluster VNet"
  type        = string
}

variable "target_vnet_id" {
  description = "Resource ID of the target Redpanda/Kafka VNet"
  type        = string
}
