output "cluster_endpoint" {
  description = "EKS cluster API server endpoint"
  value       = aws_eks_cluster.main.endpoint
}

output "cluster_name" {
  description = "EKS cluster name (auto-generated if not specified in tfvars)"
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

output "region" {
  description = "AWS region"
  value       = var.region
}

output "kubeconfig_command" {
  description = "Run this command to configure kubectl after apply"
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${local.cluster_name}"
}

output "terraform_operator_ip" {
  description = "Public IP detected at plan time — use as controlPlane.allowedCIDRs[0] in helm install"
  value       = chomp(data.http.my_ip.response_body)
}

output "helm_install_command" {
  description = "Ready-to-run helm install command with all AWS-specific values pre-filled"
  value       = <<-EOT
    helm install omb charts/omb -n omb \
      -f charts/omb/values-aws.yaml \
      --set "controlPlane.allowedCIDRs[0]=${chomp(data.http.my_ip.response_body)}/32" \
      --set clusterAutoscaler.clusterName=${local.cluster_name} \
      --set clusterAutoscaler.region=${var.region} \
      --set clusterAutoscaler.roleArn=${aws_iam_role.cluster_autoscaler.arn}
  EOT
}

output "find_elb_sg_command" {
  description = "The ELB security group is created by Kubernetes when the LoadBalancer Service is provisioned — Terraform cannot reference it directly. After helm install, run this to find it:"
  value       = "aws elb describe-load-balancers --region ${var.region} --query 'LoadBalancerDescriptions[*].{Name:LoadBalancerName,SGName:SourceSecurityGroup.GroupName}' --output table"
}
