resource "google_compute_network" "main" {
  name                    = "${var.cluster_name}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  name          = "${var.cluster_name}-subnet"
  ip_cidr_range = var.vpc_cidr
  region        = var.region
  network       = google_compute_network.main.id
}

resource "google_container_cluster" "main" {
  name     = var.cluster_name
  location = var.region

  # Remove default node pool immediately; manage nodes via google_container_node_pool
  remove_default_node_pool = true
  initial_node_count       = 1

  network    = google_compute_network.main.name
  subnetwork = google_compute_subnetwork.main.name

  # Standard mode required for hostNetwork: true on pods
  deletion_protection = false
}

resource "google_container_node_pool" "workers" {
  name     = "${var.cluster_name}-workers"
  location = var.region
  cluster  = google_container_cluster.main.name

  initial_node_count = 3

  autoscaling {
    min_node_count = 2
    max_node_count = 6
  }

  node_config {
    machine_type = "n2-standard-16"
    disk_size_gb = 100
    disk_type    = "pd-ssd"

    # Cloud platform scope required for GKE to manage nodes
    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    labels = var.labels

    metadata = {
      disable-legacy-endpoints = "true"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

resource "google_compute_network_peering" "to_target" {
  count = var.target_network != "" ? 1 : 0

  name         = "${var.cluster_name}-to-target"
  network      = google_compute_network.main.self_link
  peer_network = var.target_network
}

resource "google_compute_firewall" "omb_workers_8080" {
  name    = "${var.cluster_name}-omb-8080"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }

  # Allow intra-subnet (worker-to-worker) and from peered target if configured
  source_ranges = compact([
    var.vpc_cidr,
    var.target_cidr,
  ])
}
