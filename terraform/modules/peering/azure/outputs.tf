output "peering_id" {
  description = "Resource ID of the VNet peering"
  value       = azurerm_virtual_network_peering.omb_to_target.id
}

output "peering_name" {
  description = "Name of the VNet peering resource"
  value       = azurerm_virtual_network_peering.omb_to_target.name
}
