output "cluster_endpoint" {
  description = "EKS cluster API server endpoint"
  value       = aws_eks_cluster.main.endpoint
}

output "cluster_name" {
  description = "EKS cluster name"
  value       = aws_eks_cluster.main.name
}

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "VPC CIDR block"
  value       = aws_vpc.main.cidr_block
}

output "private_subnet_ids" {
  description = "Private subnet IDs (used by Helm chart)"
  value       = aws_subnet.private[*].id
}

output "node_role_arn" {
  description = "IAM role ARN for worker nodes"
  value       = aws_iam_role.node_group.arn
}

output "cluster_autoscaler_iam_role_arn" {
  description = "IAM role ARN for the Cluster Autoscaler — pass to Helm chart via clusterAutoscaler.roleArn"
  value       = aws_iam_role.cluster_autoscaler.arn
}

output "vpc_peering_connection_id" {
  description = "VPC peering connection ID — share with Redpanda BYOC to accept the peering request"
  value       = length(aws_vpc_peering_connection.target) > 0 ? aws_vpc_peering_connection.target[0].id : ""
}

output "kubeconfig_command" {
  description = "Run this command to configure kubectl after apply"
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${var.cluster_name}"
}
