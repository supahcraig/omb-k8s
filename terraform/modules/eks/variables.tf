variable "cluster_name" {
  description = "Name of the EKS cluster and all related AWS resources"
  type        = string
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

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}
