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

variable "target_vpc_id" {
  description = "VPC ID of the target Redpanda/Kafka cluster"
  type        = string
}

variable "target_vpc_cidr" {
  description = "CIDR block of the target cluster VPC"
  type        = string
}

variable "target_security_group_id" {
  description = "Security group ID attached to Redpanda broker nodes — when provided, Terraform adds an inbound rule allowing the OMB VPC CIDR on ports 9092-9093; omit if the target SG is managed outside this module"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to peering resources"
  type        = map(string)
  default     = {}
}
