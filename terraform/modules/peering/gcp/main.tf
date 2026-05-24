resource "google_compute_network_peering" "omb_to_target" {
  name         = "omb-to-target"
  network      = var.source_network
  peer_network = var.target_network
}
