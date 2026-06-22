output "cluster_name" {
  description = "EKS cluster name"
  value       = aws_eks_cluster.main.name
}

output "cluster_endpoint" {
  description = "EKS API server endpoint"
  value       = aws_eks_cluster.main.endpoint
}

output "vpc_id" {
  description = "VPC ID — pass to OMB terraform as target_vpc_id to enable VPC peering"
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "VPC CIDR — pass to OMB terraform as target_cidr"
  value       = var.vpc_cidr
}

output "redpanda_security_group_id" {
  description = "Security group on broker nodes — pass to OMB terraform as target_security_group_id"
  value       = aws_security_group.redpanda.id
}

output "kubeconfig_command" {
  description = "Configure kubectl for this cluster"
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${aws_eks_cluster.main.name}"
}

output "cluster_info" {
  description = "Run after terraform apply (or after any node roll) to get current broker IPs, CA cert, and Prometheus endpoints"
  value       = <<-EOT

    export KUBECONFIG=$(pwd)/kubeconfig
    aws eks update-kubeconfig --region ${var.region} --name ${aws_eks_cluster.main.name} --kubeconfig $(pwd)/kubeconfig

    # ── Broker seed list (paste into OMB UI → Settings → bootstrap.servers) ──
    kubectl get nodes -l node-pool=redpanda \
      -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address}{":9092,"}{end}' \
      | sed 's/,$//'

    # ── CA certificate (save as redpanda-ca.pem, upload in OMB UI → Settings) ──
    kubectl -n source get secret redpanda-external-root-certificate \
      -o jsonpath='{.data.ca\.crt}' | base64 -d > redpanda-ca.pem

    # ── Prometheus scrape endpoints (one per broker, port 9644) ──────────────
    kubectl get nodes -l node-pool=redpanda \
      -o jsonpath='{range .items[*]}http://{.status.addresses[?(@.type=="InternalIP")].address}:9644/metrics{"\n"}{end}'

  EOT
}

output "post_install_steps" {
  description = "Run these after terraform apply to prepare the cluster for Redpanda"
  value       = <<-EOT

    # 1. Configure kubectl (session-local — won't touch your main ~/.kube/config)
    export KUBECONFIG=$(pwd)/kubeconfig
    $(terraform output -raw kubeconfig_command)

    # 2. Install cert-manager (required by Redpanda operator for TLS certificates)
    helm repo add jetstack https://charts.jetstack.io && helm repo update
    helm install cert-manager jetstack/cert-manager \
      -n cert-manager --create-namespace \
      --set crds.enabled=true

    # 3. Install csi-driver-lvm (creates LVM volumes on the NVMe instance store)
    helm repo add metal-stack https://helm.metal-stack.io
    helm repo update
    helm install csi-driver-lvm metal-stack/csi-driver-lvm \
      --version 0.6.0 \
      --namespace csi-driver-lvm \
      --create-namespace \
      --set lvm.devicePattern='/dev/nvme0n[0-9]'

    # 4. Apply the Redpanda StorageClass (depends on csi-driver-lvm being installed)
    kubectl apply -f ../../redpanda-storageclass.yaml

    # 5. Install the Redpanda operator
    helm repo add redpanda https://charts.redpanda.com && helm repo update
    helm upgrade --install redpanda-controller redpanda/operator \
      --namespace redpanda \
      --create-namespace \
      --version v26.1.3 \
      --set crds.enabled=true

    # 6. Deploy the cluster (redpanda-cluster.yaml is at the repo root)
    kubectl apply -f ../../redpanda-cluster.yaml
  EOT
}
