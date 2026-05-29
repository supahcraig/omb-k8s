output "cluster_endpoint" {
  description = "AKS cluster API server URL"
  value       = azurerm_kubernetes_cluster.main.kube_config[0].host
}

output "cluster_name" {
  description = "AKS cluster name (auto-generated if not specified in tfvars)"
  value       = azurerm_kubernetes_cluster.main.name
}

output "vpc_id" {
  description = "VNet resource ID"
  value       = azurerm_virtual_network.main.id
}

output "vpc_cidr" {
  description = "VNet address space (first range)"
  value       = azurerm_virtual_network.main.address_space[0]
}

output "kubeconfig" {
  description = "Raw kubeconfig content (sensitive)"
  value       = azurerm_kubernetes_cluster.main.kube_config_raw
  sensitive   = true
}

output "kubeconfig_command" {
  description = "Run this command to configure kubectl after apply"
  value       = "az aks get-credentials --resource-group ${var.resource_group_name} --name ${local.cluster_name}"
}

output "terraform_operator_ip" {
  description = "Public IP detected at plan time — use as controlPlane.allowedCIDRs[0] in helm install"
  value       = chomp(data.http.my_ip.response_body)
}
