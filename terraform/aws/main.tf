resource "random_pet" "cluster_suffix" {
  length = 2
}

data "http" "my_ip" {
  url = "https://ipv4.icanhazip.com"
}

locals {
  cluster_name = var.cluster_name != "" ? var.cluster_name : "omb-${random_pet.cluster_suffix.id}"
}
