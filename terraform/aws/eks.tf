resource "aws_security_group" "omb_workers" {
  name        = "${local.cluster_name}-omb-workers"
  description = "Additional SG for OMB worker port 9080 communication"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "OMB worker-to-worker on port 9080"
    from_port   = 9080
    to_port     = 9080
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
    Name = "${local.cluster_name}-omb-workers"
  })
}

resource "aws_eks_cluster" "main" {
  name     = local.cluster_name
  role_arn = aws_iam_role.eks_cluster.arn

  vpc_config {
    subnet_ids               = aws_subnet.private[*].id
    endpoint_private_access  = true
    endpoint_public_access   = true
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_cluster_policy,
  ]

  tags = var.tags
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name             = aws_eks_cluster.main.name
  addon_name               = "aws-ebs-csi-driver"
  service_account_role_arn = aws_iam_role.ebs_csi.arn

  depends_on = [aws_eks_node_group.control_plane]
}

# ── Control-plane node pool ───────────────────────────────────────────────────
# m5.xlarge (4 vCPU / 16 GB), fixed at 2 nodes, no autoscaling.
# Runs: control-plane, Prometheus, Grafana, Cluster Autoscaler, driver Jobs.

resource "aws_launch_template" "control_plane" {
  name_prefix   = "${local.cluster_name}-control-plane-"
  instance_type = "m5.xlarge"

  vpc_security_group_ids = [
    aws_eks_cluster.main.vpc_config[0].cluster_security_group_id,
  ]

  tag_specifications {
    resource_type = "instance"
    tags = merge(var.tags, {
      Name = "${local.cluster_name}-control-plane"
    })
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_eks_node_group" "control_plane" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${local.cluster_name}-control-plane"
  node_role_arn   = aws_iam_role.node_group.arn
  subnet_ids      = aws_subnet.private[*].id

  launch_template {
    id      = aws_launch_template.control_plane.id
    version = aws_launch_template.control_plane.latest_version
  }

  scaling_config {
    desired_size = 2
    min_size     = 2
    max_size     = 2
  }

  update_config {
    max_unavailable = 1
  }

  labels = {
    "node-pool" = "control-plane"
  }

  depends_on = [
    aws_iam_role_policy_attachment.node_group_worker,
    aws_iam_role_policy_attachment.node_group_cni,
    aws_iam_role_policy_attachment.node_group_ecr,
  ]

  tags = var.tags
}

# ── Benchmark-worker node pool ────────────────────────────────────────────────
# m5.4xlarge (16 vCPU / 64 GB), autoscales 0–20.
# Tainted dedicated=benchmark:NoSchedule so only omb-worker pods land here.
# Port 9080 SG attached for worker-to-worker communication.

resource "aws_launch_template" "benchmark_workers" {
  name_prefix   = "${local.cluster_name}-benchmark-workers-"
  instance_type = "m5.4xlarge"

  vpc_security_group_ids = [
    aws_eks_cluster.main.vpc_config[0].cluster_security_group_id,
    aws_security_group.omb_workers.id,
  ]

  tag_specifications {
    resource_type = "instance"
    tags = merge(var.tags, {
      Name = "${local.cluster_name}-benchmark-worker"
    })
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_eks_node_group" "benchmark_workers" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${local.cluster_name}-benchmark-workers"
  node_role_arn   = aws_iam_role.node_group.arn
  subnet_ids      = aws_subnet.private[*].id

  launch_template {
    id      = aws_launch_template.benchmark_workers.id
    version = aws_launch_template.benchmark_workers.latest_version
  }

  scaling_config {
    desired_size = 2
    min_size     = 0
    max_size     = 20
  }

  update_config {
    max_unavailable = 1
  }

  labels = {
    "node-pool" = "worker"
  }

  taint {
    key    = "dedicated"
    value  = "benchmark"
    effect = "NO_SCHEDULE"
  }

  # Required tags for Cluster Autoscaler node group discovery
  tags = merge(var.tags, {
    "k8s.io/cluster-autoscaler/enabled"             = "true"
    "k8s.io/cluster-autoscaler/${local.cluster_name}" = "owned"
  })

  depends_on = [
    aws_iam_role_policy_attachment.node_group_worker,
    aws_iam_role_policy_attachment.node_group_cni,
    aws_iam_role_policy_attachment.node_group_ecr,
  ]

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
}

# ── Redpanda node pool ────────────────────────────────────────────────────────
# c8g.8xlarge (32 vCPU / 64 GB, Graviton 4 ARM64), fixed at 6 nodes.
# Labeled node-pool=redpanda, tainted dedicated=redpanda:NoSchedule.
# User data formats any NVMe instance store devices to /mnt/nvme at boot.
# NOTE: c8g does not include NVMe instance store — that requires im4gn or
# is4gen instance families. If NVMe is required, change instance_type.

resource "aws_launch_template" "redpanda" {
  name_prefix   = "${local.cluster_name}-redpanda-"
  instance_type = "c8g.8xlarge"

  # Runs before the EKS bootstrap script. Formats any NVMe instance store
  # devices as XFS and mounts them at /mnt/nvme for local-path-provisioner.
  # Gracefully no-ops when no instance store devices are present.
  # AL2023 managed node groups require MIME multipart user data format.
  user_data = base64encode(<<-EOT
    MIME-Version: 1.0
    Content-Type: multipart/mixed; boundary="==BOUNDARY=="

    --==BOUNDARY==
    Content-Type: text/x-shellscript; charset="us-ascii"

    #!/bin/bash
    set -e
    NVME_DEVS=$(lsblk -dpno NAME | grep -E '^/dev/nvme[1-9]' || true)
    if [ -n "$NVME_DEVS" ]; then
      DEV_COUNT=$(echo "$NVME_DEVS" | wc -l | tr -d ' ')
      if [ "$DEV_COUNT" -gt 1 ]; then
        dnf install -y mdadm 2>/dev/null || true
        mdadm --create /dev/md0 --level=0 --raid-devices="$DEV_COUNT" $NVME_DEVS --force
        mkfs.xfs -f /dev/md0
        mkdir -p /mnt/nvme
        echo "/dev/md0 /mnt/nvme xfs defaults,noatime 0 2" >> /etc/fstab
      else
        mkfs.xfs -f $NVME_DEVS
        mkdir -p /mnt/nvme
        echo "$NVME_DEVS /mnt/nvme xfs defaults,noatime 0 2" >> /etc/fstab
      fi
      mount -a
    fi
    mkdir -p /mnt/nvme

    --==BOUNDARY==--
  EOT
  )

  vpc_security_group_ids = [
    aws_eks_cluster.main.vpc_config[0].cluster_security_group_id,
  ]

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
  subnet_ids      = aws_subnet.private[*].id
  ami_type        = "AL2023_ARM_64_STANDARD"

  launch_template {
    id      = aws_launch_template.redpanda.id
    version = aws_launch_template.redpanda.latest_version
  }

  scaling_config {
    desired_size = 6
    min_size     = 6
    max_size     = 6
  }

  update_config {
    max_unavailable = 1
  }

  labels = {
    "node-pool" = "redpanda"
  }

  taint {
    key    = "dedicated"
    value  = "redpanda"
    effect = "NO_SCHEDULE"
  }

  depends_on = [
    aws_iam_role_policy_attachment.node_group_worker,
    aws_iam_role_policy_attachment.node_group_cni,
    aws_iam_role_policy_attachment.node_group_ecr,
  ]

  tags = var.tags
}
