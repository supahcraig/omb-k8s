variable "region" {
  description = "AWS region where the source VPC lives"
  type        = string
}

variable "source_vpc_id" {
  description = "VPC ID of the OMB cluster (peering initiator)"
  type        = string
}

variable "source_vpc_cidr" {
  description = "CIDR block of the OMB cluster VPC"
  type        = string
}

variable "source_route_table_ids" {
  description = "List of route table IDs in the OMB VPC to add peering routes to (typically the private route tables)"
  type        = list(string)
}

variable "target_vpc_id" {
  description = "VPC ID of the target Redpanda/Kafka cluster"
  type        = string
}

variable "target_vpc_cidr" {
  description = "CIDR block of the target cluster VPC"
  type        = string
}

variable "tags" {
  description = "Tags applied to peering resources"
  type        = map(string)
  default     = {}
}
