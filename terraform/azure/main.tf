resource "azurerm_resource_group" "main" {
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

resource "azurerm_virtual_network" "main" {
  name                = "${local.cluster_name}-vnet"
  address_space       = var.vnet_address_space
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}

resource "azurerm_subnet" "aks" {
  name                 = "${local.cluster_name}-aks-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [var.subnet_address_prefix]
}

resource "azurerm_network_security_group" "omb_workers" {
  name                = "${local.cluster_name}-omb-nsg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags

  security_rule {
    name                       = "allow-omb-9080-inbound"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "9080"
    source_address_prefix      = var.subnet_address_prefix
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "aks" {
  subnet_id                 = azurerm_subnet.aks.id
  network_security_group_id = azurerm_network_security_group.omb_workers.id
}

resource "azurerm_kubernetes_cluster" "main" {
  name                = local.cluster_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = local.cluster_name
  tags                = var.tags

  # ── Control-plane node pool ─────────────────────────────────────────────────
  # Standard_D4s_v3 (4 vCPU / 16 GB), fixed at 2 nodes.
  # Runs: control-plane, Prometheus, Grafana, driver Jobs.
  # NOTE: renaming this pool from the previous value forces cluster replacement.
  default_node_pool {
    name                = "controlplane"
    vm_size             = "Standard_D4s_v3"
    node_count          = 2
    enable_auto_scaling = false
    vnet_subnet_id      = azurerm_subnet.aks.id

    node_labels = {
      "node-pool" = "control-plane"
    }
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin = "azure"
    service_cidr   = "10.100.0.0/16"
    dns_service_ip = "10.100.0.10"
  }
}

# ── Benchmark-worker node pool ────────────────────────────────────────────────
# Standard_D16s_v3 (16 vCPU / 64 GB), autoscales 0–20.
# Tainted dedicated=benchmark:NoSchedule so only omb-worker pods land here.

resource "azurerm_kubernetes_cluster_node_pool" "benchmark_workers" {
  name                  = "workers"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.main.id
  vm_size               = "Standard_D16s_v3"
  min_count             = 0
  max_count             = 20
  node_count            = 2
  enable_auto_scaling   = true
  vnet_subnet_id        = azurerm_subnet.aks.id

  node_labels = {
    "node-pool" = "worker"
  }

  node_taints = ["dedicated=benchmark:NoSchedule"]

  tags = var.tags

  lifecycle {
    ignore_changes = [node_count]
  }
}

resource "azurerm_virtual_network_peering" "to_target" {
  count = var.target_vnet_id != "" ? 1 : 0

  name                      = "${local.cluster_name}-to-target"
  resource_group_name       = azurerm_resource_group.main.name
  virtual_network_name      = azurerm_virtual_network.main.name
  remote_virtual_network_id = var.target_vnet_id
  allow_forwarded_traffic   = true
}
