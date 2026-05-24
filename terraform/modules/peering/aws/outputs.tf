output "peering_connection_id" {
  description = "VPC peering connection ID — share with Redpanda BYOC to accept"
  value       = aws_vpc_peering_connection.main.id
}

output "peering_status" {
  description = "Current status: pending-acceptance (BYOC) or active (self-hosted same account)"
  value       = aws_vpc_peering_connection.main.accept_status
}
