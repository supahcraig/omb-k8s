output "peering_name" {
  description = "Name of the network peering resource"
  value       = google_compute_network_peering.omb_to_target.name
}

output "peering_state" {
  description = "Current state: ACTIVE (both sides created) or INACTIVE (waiting for peer)"
  value       = google_compute_network_peering.omb_to_target.state
}
