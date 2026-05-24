variable "project_id" {
  description = "GCP project ID of the OMB cluster"
  type        = string
}

variable "source_network" {
  description = "Self-link of the OMB cluster VPC network (projects/PROJECT/global/networks/NETWORK)"
  type        = string
}

variable "target_network" {
  description = "Self-link of the target Redpanda/Kafka network"
  type        = string
}
