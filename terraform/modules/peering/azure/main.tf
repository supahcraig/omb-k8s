resource "azurerm_virtual_network_peering" "omb_to_target" {
  name                      = "omb-to-target"
  resource_group_name       = var.resource_group_name
  virtual_network_name      = var.source_vnet_name
  remote_virtual_network_id = var.target_vnet_id
  allow_forwarded_traffic   = true
}
