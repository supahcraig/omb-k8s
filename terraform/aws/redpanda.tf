# ── In-cluster Redpanda node pool ─────────────────────────────────────────────
#
# Runs Redpanda brokers in the SAME EKS cluster as OMB (ported from the standalone
# terraform/redpanda/ config). r8gd.8xlarge: 32 vCPU (Graviton4 ARM64), 256 GB RAM,
# 1 × 1900 GB NVMe SSD. Nodes live in the private subnets and reach the internet
# (redpanda apt repo, EKS bootstrap) via the NAT gateways defined in vpc.tf.
#
# The node group is tainted redpanda-tuned=true:NoSchedule at kubelet registration,
# so only pods carrying a matching toleration (the Redpanda CR / Helm release) land
# here — it stays isolated from the OMB control-plane and benchmark-worker pools.

# ── Redpanda broker security group ───────────────────────────────────────────
# Scoped to the OMB VPC CIDR so the in-cluster OMB workers (hostNetwork) can reach
# broker ports, plus self for broker-to-broker internal RPC.

resource "aws_security_group" "redpanda" {
  name        = "${local.cluster_name}-redpanda"
  description = "Redpanda broker, admin, schema registry, proxy, and internal RPC ports"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "Kafka API plaintext"
    from_port   = 9092
    to_port     = 9092
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  ingress {
    description = "Kafka API TLS"
    from_port   = 9093
    to_port     = 9093
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  ingress {
    description = "Admin API"
    from_port   = 9644
    to_port     = 9644
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  ingress {
    description = "Schema Registry"
    from_port   = 8081
    to_port     = 8081
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  ingress {
    description = "HTTP Proxy (Pandaproxy)"
    from_port   = 8082
    to_port     = 8082
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
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

# ── Amazon Linux 2023 EKS ARM64 AMI (pinned) ─────────────────────────────────
# DELIBERATELY pinned to the AL2023 v20251007 build (k8s 1.33.5, kernel
# 6.12.x amzn2023) to REPRODUCE a customer environment for TSB-2026-39
# (EEVDF cgroup cpu.weight starvation, Linux 6.12–7.0). The customer runs
# `6.12.46-66.121.amzn2023.aarch64`; this AMI is the matching EKS build.
# kubelet 1.33 against the 1.36 control plane sits exactly at the supported
# n-3 skew boundary — bump this pin before any control-plane upgrade.
# (Previously: Canonical ubuntu-eks noble 24.04, kernel 6.17 — also TSB-affected.)

data "aws_ami" "redpanda_node" {
  owners = ["602401143452"] # Amazon EKS AMI account

  filter {
    name   = "name"
    values = ["amazon-eks-node-al2023-arm64-standard-1.33-v20251007"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

# ── Redpanda node group launch template ───────────────────────────────────────
# AL2023 EKS AMIs bootstrap via nodeadm, NOT /etc/eks/bootstrap.sh (Ubuntu/AL2).
# With ami_type=CUSTOM, EKS injects nothing — the user data must be MIME
# multipart carrying:
#   1. an application/node.eks.aws NodeConfig (cluster identity + kubelet taint)
#   2. a text/x-shellscript for host prep (NVMe format, containerd nofile,
#      redpanda rpm + tuner, hung-task detector), all best-effort so a failed
#      optional step never blocks the node from joining.

# NOTE: blue/green migration (2026-07-10). This LT+NG pair ("-al2023") was
# created ALONGSIDE the original Ubuntu node group, brokers were moved over,
# and the old group (omb-clear-muskox-redpanda) was then deleted via the AWS
# CLI — it was removed from terraform state rather than replaced in place.

resource "aws_launch_template" "redpanda" {
  name_prefix   = "${local.cluster_name}-redpanda-al2023-"
  instance_type = "r8gd.8xlarge"
  image_id      = data.aws_ami.redpanda_node.id

  # The LT resource itself must be tagged or the cloud-nuke reaper deletes it
  # (2026-07-10 incident: every untagged LT + ASG in the account was reaped,
  # taking down all three original node groups).
  tags = var.tags

  vpc_security_group_ids = [
    aws_eks_cluster.main.vpc_config[0].cluster_security_group_id,
    aws_security_group.redpanda.id,
  ]

  user_data = base64encode(<<-EOT
    MIME-Version: 1.0
    Content-Type: multipart/mixed; boundary="//"

    --//
    Content-Type: application/node.eks.aws

    apiVersion: node.eks.aws/v1alpha1
    kind: NodeConfig
    spec:
      cluster:
        name: ${local.cluster_name}
        apiServerEndpoint: ${aws_eks_cluster.main.endpoint}
        certificateAuthority: ${aws_eks_cluster.main.certificate_authority[0].data}
        cidr: ${aws_eks_cluster.main.kubernetes_network_config[0].service_ipv4_cidr}
      kubelet:
        flags:
          # Taint at registration so pods without a matching toleration can
          # never land here (node-pool label is reconciled by the managed
          # node group itself).
          - --register-with-taints=redpanda-tuned=true:NoSchedule

    --//
    Content-Type: text/x-shellscript

    #!/bin/bash
    # NOTE: deliberately NOT `set -e` — best-effort host prep; the node must
    # join (nodeadm handles that independently) even if an optional step fails.
    set -x

    # ── Raise the container open-file limit (nofile) ─────────────────────────
    # Two layers on AL2023, BOTH required:
    # 1. containerd's own LimitNOFILE (drop-in) — sets the HARD limit ceiling.
    # 2. /etc/containerd/base-runtime-spec.json — the EKS AL2023 AMI stamps
    #    RLIMIT_NOFILE soft=65536 into every container's OCI spec via
    #    base_runtime_spec in config.toml. The soft limit is what EMFILEs, so
    #    patch it to match the hard limit. (The Ubuntu AMI's containerd 2.x
    #    had no base spec, so the drop-in alone was enough there.)
    mkdir -p /etc/systemd/system/containerd.service.d
    printf '[Service]\nLimitNOFILE=1048576\n' > /etc/systemd/system/containerd.service.d/10-nofile.conf
    python3 - <<'PYEOF' || true
    import json
    p = "/etc/containerd/base-runtime-spec.json"
    try:
        d = json.load(open(p))
    except Exception:
        d = None
    if d is not None:
        for r in d.get("process", {}).get("rlimits", []):
            if r.get("type") == "RLIMIT_NOFILE":
                r["soft"] = 1048576
                r["hard"] = 1048576
        json.dump(d, open(p, "w"), indent=1)
    PYEOF
    systemctl daemon-reload
    systemctl restart containerd || true

    # ── Keep the hung-task detector talking (TSB-2026-39 instrumentation) ────
    # This kernel (6.12 amzn2023) is deliberately in the TSB-affected range to
    # reproduce a customer issue. The detector defaults to 10 reports then
    # mutes itself forever; unlimited reports let us correlate every EEVDF
    # starvation event in dmesg against broker wedges.
    printf 'kernel.hung_task_warnings=-1\n' > /etc/sysctl.d/99-hung-task.conf
    sysctl -w kernel.hung_task_warnings=-1 || true

    # ── Format + mount the local NVMe instance store ─────────────────────────
    # r8gd.8xlarge ships one ~1.9 TB NVMe instance-store disk. Identify it by
    # model string so we never touch the EBS root volume. local-path-provisioner
    # hands out broker PVs from /mnt/redpanda.
    dnf install -y xfsprogs || true
    RP_DEV=$(lsblk -dpno NAME,MODEL | awk '/Instance Storage/{print $1; exit}')
    if [ -n "$RP_DEV" ] && command -v mkfs.xfs >/dev/null 2>&1; then
      mkfs.xfs -f "$RP_DEV"
      mkdir -p /mnt/redpanda
      mount "$RP_DEV" /mnt/redpanda
      echo "$RP_DEV /mnt/redpanda xfs defaults,noatime,nofail 0 2" >> /etc/fstab
      mkdir -p /mnt/redpanda/local-path-provisioner
    fi

    # ── Install redpanda rpm + host tuning (best-effort) ─────────────────────
    # AL2023 uses the rpm repo (Ubuntu used deb). Expected non-fatal tune
    # failures on EKS: net (ENA), disk_write_cache (AWS only), fstrim (no dbus).
    (
      curl -1sLf 'https://dl.redpanda.com/nzc4ZYQK3WRGd9sy/redpanda/cfg/setup/bash.rpm.sh' | bash
      dnf install -y redpanda
      rpk redpanda mode production
      rpk redpanda tune all
      systemctl enable redpanda-tuner
      systemctl start redpanda-tuner
    ) || true
    --//--
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
  node_group_name = "${local.cluster_name}-redpanda-al2023"
  node_role_arn   = aws_iam_role.node_group.arn
  subnet_ids      = aws_subnet.private[*].id

  # CUSTOM because the launch template pins an explicit image_id (Ubuntu ARM64).
  # With a custom AMI, EKS skips its own bootstrap injection — our user data
  # calls /etc/eks/bootstrap.sh directly.
  ami_type = "CUSTOM"

  launch_template {
    id      = aws_launch_template.redpanda.id
    version = aws_launch_template.redpanda.latest_version
  }

  scaling_config {
    desired_size = var.redpanda_node_count
    min_size     = var.redpanda_node_count
    max_size     = var.redpanda_node_count
  }

  update_config {
    max_unavailable = 1
  }

  # Redpanda CR / Helm nodeSelector targets this label.
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
