variable "cluster_name" {
  description = "Name of the EKS cluster and all related AWS resources. Leave empty to auto-generate as omb-<random-pet>."
  type        = string
  default     = ""
}

variable "region" {
  description = "AWS region to deploy into (e.g. us-east-1)"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the new VPC — must not overlap with target_cidr"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of AZs for subnets — minimum 2 required by EKS"
  type        = list(string)
}

variable "target_vpc_id" {
  description = "VPC ID of the Redpanda/Kafka cluster to peer with; leave empty to skip peering"
  type        = string
  default     = ""
}

variable "target_cidr" {
  description = "CIDR block of the target VPC — required when target_vpc_id is set"
  type        = string
  default     = ""
}

variable "target_security_group_id" {
  description = "Security group ID attached to Redpanda broker nodes — when provided, Terraform adds an inbound rule allowing the OMB VPC CIDR on ports 9092-9093; omit if the target SG is managed outside this module"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}
