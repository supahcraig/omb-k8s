resource "random_pet" "cluster_suffix" {
  length = 2
}

locals {
  cluster_name = var.cluster_name != "" ? var.cluster_name : "redpanda-${random_pet.cluster_suffix.id}"
}
