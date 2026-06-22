variable "cluster_name" {
  description = "Name for the EKS cluster and all related AWS resources. Leave empty to auto-generate as redpanda-<random-pet>."
  type        = string
  default     = ""
}

variable "region" {
  description = "AWS region to deploy into (e.g. us-east-1)"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the /16 VPC — must not overlap with your OMB cluster VPC"
  type        = string
  default     = "10.1.0.0/16"
}

variable "availability_zones" {
  description = "Exactly 3 AZs for the public subnets — one Redpanda node lands in each"
  type        = list(string)
  validation {
    condition     = length(var.availability_zones) == 3
    error_message = "Exactly 3 availability zones are required (one per Redpanda node)."
  }
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks permitted to reach Redpanda broker ports. Include your OMB cluster VPC CIDR and workstation IPs."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}
