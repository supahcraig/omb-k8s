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
  location = var.zone

  # Remove default node pool immediately; manage nodes via google_container_node_pool
  remove_default_node_pool = true
  initial_node_count       = 1

  network    = google_compute_network.main.name
  subnetwork = google_compute_subnetwork.main.name

  # Standard mode required for hostNetwork: true on pods
  deletion_protection = false
}

# ── Control-plane node pool ───────────────────────────────────────────────────
# n2-standard-4 (4 vCPU / 16 GB), fixed at 2 nodes, no autoscaling.
# Runs: control-plane, Prometheus, Grafana, driver Jobs.

resource "google_container_node_pool" "control_plane" {
  name       = "${var.cluster_name}-control-plane"
  location   = var.zone
  cluster    = google_container_cluster.main.name

  node_count = 2

  node_config {
    machine_type = "n2-standard-4"
    disk_size_gb = 100
    disk_type    = "pd-ssd"

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    labels = merge(var.labels, {
      "node-pool" = "control-plane"
    })

    metadata = {
      disable-legacy-endpoints = "true"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

# ── Benchmark-worker node pool ────────────────────────────────────────────────
# n2-standard-16 (16 vCPU / 64 GB), autoscales 0–20.
# Tainted dedicated=benchmark:NoSchedule — toleration must use NoSchedule (camelCase).

resource "google_container_node_pool" "benchmark_workers" {
  name     = "${var.cluster_name}-benchmark-workers"
  location = var.zone
  cluster  = google_container_cluster.main.name

  initial_node_count = 2

  autoscaling {
    min_node_count = 0
    max_node_count = 20
  }

  node_config {
    machine_type = "n2-standard-16"
    disk_size_gb = 100
    disk_type    = "pd-ssd"

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    labels = merge(var.labels, {
      "node-pool" = "worker"
    })

    taint {
      key    = "dedicated"
      value  = "benchmark"
      effect = "NO_SCHEDULE"
    }

    metadata = {
      disable-legacy-endpoints = "true"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  depends_on = [google_container_node_pool.control_plane]

  lifecycle {
    ignore_changes = [initial_node_count]
  }
}

resource "google_compute_network_peering" "to_target" {
  count = var.target_network != "" ? 1 : 0

  name         = "${var.cluster_name}-to-target"
  network      = google_compute_network.main.self_link
  peer_network = var.target_network
}

resource "google_compute_firewall" "omb_workers_8080" {
  name    = "${var.cluster_name}-omb-worker"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    ports    = ["9080"]
  }

  # vpc_cidr: node-to-node traffic
  # pod_cidr: control-plane pod traffic (control plane does not use hostNetwork)
  # target_cidr: peered target cluster if configured
  source_ranges = compact([
    var.vpc_cidr,
    var.pod_cidr,
    var.target_cidr,
  ])
}
