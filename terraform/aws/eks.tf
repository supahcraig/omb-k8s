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

