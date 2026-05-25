output "cluster_endpoint" {
  description = "GKE cluster master endpoint"
  value       = "https://${google_container_cluster.main.endpoint}"
}

output "cluster_name" {
  description = "GKE cluster name"
  value       = google_container_cluster.main.name
}

output "vpc_id" {
  description = "VPC network self_link"
  value       = google_compute_network.main.self_link
}

output "vpc_cidr" {
  description = "VPC subnet CIDR"
  value       = google_compute_subnetwork.main.ip_cidr_range
}

output "kubeconfig_command" {
  description = "Run this command to configure kubectl after apply"
  value       = "gcloud container clusters get-credentials ${var.cluster_name} --zone ${var.zone} --project ${var.project_id}"
}
