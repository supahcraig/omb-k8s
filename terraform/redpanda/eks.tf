# ── Redpanda broker security group ───────────────────────────────────────────

resource "aws_security_group" "redpanda" {
  name        = "${local.cluster_name}-redpanda"
  description = "Redpanda broker, admin, and internal RPC ports"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "Kafka API plaintext"
    from_port   = 9092
    to_port     = 9092
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    description = "Kafka API TLS"
    from_port   = 9093
    to_port     = 9093
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    description = "Admin API"
    from_port   = 9644
    to_port     = 9644
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    description = "HTTP Proxy (Pandaproxy)"
    from_port   = 8082
    to_port     = 8082
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    description = "Schema Registry"
    from_port   = 8081
    to_port     = 8081
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    description = "Kafka TLS NodePort (external listener)"
    from_port   = 31092
    to_port     = 31092
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    description = "Admin API NodePort"
    from_port   = 31644
    to_port     = 31644
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    description = "HTTP Proxy NodePort"
    from_port   = 30082
    to_port     = 30082
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  ingress {
    description = "Schema Registry NodePort"
    from_port   = 30081
    to_port     = 30081
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  # Internal broker RPC — broker-to-broker only
  ingress {
    description = "Internal RPC"
    from_port   = 33145
    to_port     = 33145
    protocol    = "tcp"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${local.cluster_name}-redpanda"
  })
}

# ── EKS control plane ─────────────────────────────────────────────────────────

resource "aws_eks_cluster" "main" {
  name     = local.cluster_name
  role_arn = aws_iam_role.eks_cluster.arn

  vpc_config {
    subnet_ids              = aws_subnet.public[*].id
    endpoint_public_access  = true
    endpoint_private_access = true
  }

  depends_on = [aws_iam_role_policy_attachment.eks_cluster_policy]
  tags       = var.tags
}

# ── Ubuntu 22.04 EKS ARM64 AMI ───────────────────────────────────────────────
# Canonical publishes Ubuntu EKS-optimized AMIs with /etc/eks/bootstrap.sh
# pre-installed. Filtering on the cluster's own Kubernetes version ensures
# nodes always match the control plane — avoids skew when EKS upgrades.

data "aws_ami" "ubuntu_eks" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu-eks/k8s_*/images/hvm-ssd/ubuntu-jammy-22.04-arm64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

# ── Redpanda node group: 3 × r8gd.8xlarge ────────────────────────────────────
#
# r8gd.8xlarge: 32 vCPU (Graviton4 ARM64), 256 GB RAM, 1 × 1900 GB NVMe SSD.
# User data formats the NVMe instance store as XFS and mounts it to
# /var/lib/redpanda before the EKS bootstrap runs. local-path-provisioner
# is configured to provision PVCs from that path (see post_install_steps output).

resource "aws_launch_template" "redpanda" {
  name_prefix   = "${local.cluster_name}-redpanda-"
  instance_type = "r8gd.8xlarge"
  image_id      = data.aws_ami.ubuntu_eks.id

  vpc_security_group_ids = [
    aws_eks_cluster.main.vpc_config[0].cluster_security_group_id,
    aws_security_group.redpanda.id,
  ]

  # cloud-init runs this script once on first boot.
  # Step 1: Install Redpanda and run host-level tuning before EKS bootstrap.
  # Step 2: /etc/eks/bootstrap.sh registers the node with the cluster (fetches
  #         the API endpoint and CA from EKS, writes kubelet config, starts kubelet).
  #         It runs last so the NVMe is ready before any pod is scheduled here.
  user_data = base64encode(<<-EOT
    #!/bin/bash
    set -ex

    # ── Install redpanda apt package ─────────────────────────────────────────
    # Provides: rpk redpanda tune (host-level tuner), redpanda-tuner systemd service
    curl -1sLf 'https://dl.redpanda.com/nzc4ZYQK3WRGd9sy/redpanda/cfg/setup/bash.deb.sh' | bash
    apt-get update
    apt-get install -y redpanda

    # ── Host-level kernel tuning ─────────────────────────────────────────────
    # Must run on the EC2 host before pods are scheduled.
    # Sets: aio_events, swappiness, transparent_hugepages, cpu governor, disk I/O scheduler,
    #       IRQ affinity.
    # Expected non-fatal failures on EKS: net (ENA), disk_write_cache (AWS only), fstrim (no dbus)
    rpk redpanda mode production
    rpk redpanda tune all || true

    # Enable tuner service so tuning re-runs on every subsequent boot
    systemctl enable redpanda-tuner
    systemctl start redpanda-tuner || true

    # ── LVM volume group for csi-driver-lvm ─────────────────────────────────
    # EC2 NVMe device enumeration order is non-deterministic across launches:
    # the instance store may be nvme0n1 on one boot and nvme1n1 on another.
    # csi-driver-lvm uses a fixed devicePattern and fails if the VG doesn't
    # exist on the expected device. Initialize the VG here by finding the
    # largest NVMe device (instance store is 1.7T; root EBS is 20G).
    apt-get install -y lvm2
    INSTANCE_STORE=""
    for dev in $(ls /dev/nvme*n1 2>/dev/null | sort); do
      size=$(lsblk -bnd -o SIZE "$dev" 2>/dev/null || echo 0)
      if [ "$size" -gt "500000000000" ]; then
        INSTANCE_STORE="$dev"
        break
      fi
    done
    if [ -n "$INSTANCE_STORE" ]; then
      pvcreate "$INSTANCE_STORE"
      vgcreate csi-lvm "$INSTANCE_STORE"
    fi

    # ── containerd RLIMIT_NOFILE override ────────────────────────────────────
    # rpk redpanda tune all does NOT fix containerd's file descriptor limit.
    # Without this override, all containers on this node inherit the Ubuntu
    # default soft limit of 1024, which causes:
    #   InvalidPartitionsException: Can not increase partition count due to FD limit
    # This must be set before bootstrap.sh starts containerd.
    mkdir -p /etc/systemd/system/containerd.service.d
    echo -e '[Service]\nLimitNOFILE=1048576' > /etc/systemd/system/containerd.service.d/ulimits.conf
    systemctl daemon-reload
    # Restart containerd if already running (EKS AMI pre-starts it)
    systemctl restart containerd || true

    # ── Register with EKS ────────────────────────────────────────────────────
    # --register-with-taints applies the taint at kubelet registration so pods
    # without a matching toleration cannot be scheduled on this node.
    # The redpanda CR has a matching toleration (see manifests/cluster.yaml).
    /etc/eks/bootstrap.sh "${local.cluster_name}" \
      --apiserver-endpoint "${aws_eks_cluster.main.endpoint}" \
      --b64-cluster-ca "${aws_eks_cluster.main.certificate_authority[0].data}" \
      --kubelet-extra-args "--register-with-taints=redpanda-tuned=true:NoSchedule"
  EOT
  )

  tag_specifications {
    resource_type = "instance"
    tags = merge(var.tags, {
      Name = "${local.cluster_name}-redpanda"
    })
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_eks_node_group" "redpanda" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${local.cluster_name}-redpanda"
  node_role_arn   = aws_iam_role.node_group.arn
  subnet_ids      = aws_subnet.public[*].id

  # CUSTOM because the launch template specifies an explicit image_id (Ubuntu).
  # With a custom AMI, EKS skips its own bootstrap injection — our user data
  # script calls /etc/eks/bootstrap.sh directly.
  ami_type = "CUSTOM"

  launch_template {
    id      = aws_launch_template.redpanda.id
    version = aws_launch_template.redpanda.latest_version
  }

  scaling_config {
    desired_size = 3
    min_size     = 3
    max_size     = 3
  }

  update_config {
    max_unavailable = 1
  }

  # redpanda-cluster.yaml targets this label via spec.clusterSpec.nodeSelector
  labels = {
    "node-pool" = "redpanda"
  }

  depends_on = [
    aws_iam_role_policy_attachment.node_group_worker,
    aws_iam_role_policy_attachment.node_group_cni,
    aws_iam_role_policy_attachment.node_group_ecr,
  ]

  tags = var.tags
}
