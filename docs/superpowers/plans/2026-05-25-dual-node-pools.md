# Dual Node Pool Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single node pool in each cloud's Terraform module into a fixed control-plane pool (m5.xlarge / n2-standard-4 / Standard_D4s_v3) and an autoscaling benchmark-worker pool (m5.4xlarge / n2-standard-16 / Standard_D16s_v3), then wire Helm so every workload lands on the correct pool.

**Architecture:** Two pools with a `node-pool` Kubernetes label disambiguate placement. Worker nodes carry a `dedicated=benchmark:NoSchedule` taint so non-worker pods cannot land on them unless they explicitly tolerate it. Control-plane, Prometheus, Grafana, Cluster Autoscaler, and driver Jobs all get a `nodeSelector` pinning them to the control-plane pool; worker StatefulSet pods get both a `nodeSelector` and a matching toleration. Node-exporter runs on all nodes (DaemonSet) but needs a toleration so it can reach the tainted worker nodes.

**Tech Stack:** Terraform (AWS provider, Google provider, AzureRM provider), Helm/Kubernetes YAML.

---

## File Map

| File | Change |
|---|---|
| `terraform/aws/eks.tf` | Rename `workers` node group → `control_plane` (m5.xlarge, fixed 2); add new `benchmark_workers` node group (m5.4xlarge, 0–20, taint, autoscaler tags) |
| `terraform/gcp/main.tf` | Rename `workers` node pool → `control_plane` (n2-standard-4, fixed 2); add new `benchmark_workers` node pool (n2-standard-16, 0–20, taint) |
| `terraform/azure/main.tf` | Rename `default_node_pool` to `controlplane` (Standard_D4s_v3, 2 fixed); add `azurerm_kubernetes_cluster_node_pool.benchmark_workers` (Standard_D16s_v3, 0–20, taint) |
| `charts/omb/templates/worker/statefulset.yaml` | Add `nodeSelector` + `tolerations`; confirm anti-affinity present |
| `charts/omb/templates/control-plane/deployment.yaml` | Add `nodeSelector` |
| `charts/omb/templates/cluster-autoscaler/deployment.yaml` | Add `nodeSelector` |
| `charts/omb/templates/jobs/driver-job.yaml` | Add `nodeSelector` + resource requests (500m / 512Mi) |
| `charts/omb/values.yaml` | Add `kube-prometheus-stack` nodeSelector entries for prometheus, grafana, prometheusOperator, kube-state-metrics; add node-exporter toleration |
| `CLAUDE.md` | Document dual-pool decisions |

---

## Task 1: Create the feature branch

**Files:** none (git only)

- [ ] **Step 1: Create and switch to the new branch**

```bash
git checkout main
git checkout -b feat/dual-node-pools
```

Expected: `Switched to a new branch 'feat/dual-node-pools'`

- [ ] **Step 2: Verify branch**

```bash
git branch --show-current
```

Expected: `feat/dual-node-pools`

---

## Task 2: AWS EKS — split into control-plane and benchmark-worker node groups

**Files:**
- Modify: `terraform/aws/eks.tf`

### Background

Currently there is one node group (`aws_eks_node_group.workers`) and one launch template (`aws_launch_template.workers`). After this task there will be two of each. The control-plane launch template only needs the cluster security group; the worker launch template keeps the `omb_workers` SG for port 8080. The EBS CSI addon `depends_on` reference also needs updating.

- [ ] **Step 1: Replace the entire contents of `terraform/aws/eks.tf`**

```hcl
resource "aws_security_group" "omb_workers" {
  name        = "${var.cluster_name}-omb-workers"
  description = "Additional SG for OMB worker port 8080 communication"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "OMB worker-to-worker on port 8080"
    from_port   = 8080
    to_port     = 8080
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
    Name = "${var.cluster_name}-omb-workers"
  })
}

resource "aws_eks_cluster" "main" {
  name     = var.cluster_name
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
  name_prefix   = "${var.cluster_name}-control-plane-"
  instance_type = "m5.xlarge"

  vpc_security_group_ids = [
    aws_eks_cluster.main.vpc_config[0].cluster_security_group_id,
  ]

  tag_specifications {
    resource_type = "instance"
    tags = merge(var.tags, {
      Name = "${var.cluster_name}-control-plane"
    })
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_eks_node_group" "control_plane" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.cluster_name}-control-plane"
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
# Port 8080 SG attached for worker-to-worker communication.

resource "aws_launch_template" "benchmark_workers" {
  name_prefix   = "${var.cluster_name}-benchmark-workers-"
  instance_type = "m5.4xlarge"

  vpc_security_group_ids = [
    aws_eks_cluster.main.vpc_config[0].cluster_security_group_id,
    aws_security_group.omb_workers.id,
  ]

  tag_specifications {
    resource_type = "instance"
    tags = merge(var.tags, {
      Name = "${var.cluster_name}-benchmark-worker"
    })
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_eks_node_group" "benchmark_workers" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.cluster_name}-benchmark-workers"
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
    "k8s.io/cluster-autoscaler/${var.cluster_name}" = "owned"
  })

  depends_on = [
    aws_iam_role_policy_attachment.node_group_worker,
    aws_iam_role_policy_attachment.node_group_cni,
    aws_iam_role_policy_attachment.node_group_ecr,
  ]
}
```

- [ ] **Step 2: Validate the Terraform**

```bash
cd terraform/aws && terraform validate
```

Expected: `Success! The configuration is valid.`

(If `terraform init` has not been run, run it first: `terraform init -backend=false`)

- [ ] **Step 3: Commit**

```bash
git add terraform/aws/eks.tf
git commit -m "feat(aws): split EKS into control-plane and benchmark-worker node groups"
```

---

## Task 3: GCP GKE — split into control-plane and benchmark-worker node pools

**Files:**
- Modify: `terraform/gcp/main.tf`

### Background

Currently there is one node pool (`google_container_node_pool.workers`). After this task there are two. GKE has a built-in cluster autoscaler — no external binary required. For GCP, taints use `effect = "NO_SCHEDULE"` (screaming snake). The control-plane pool uses `n2-standard-4` (4 vCPU / 16 GB), matching m5.xlarge.

- [ ] **Step 1: Replace the entire contents of `terraform/gcp/main.tf`**

```hcl
resource "google_compute_network" "main" {
  name                    = "${var.cluster_name}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  name          = "${var.cluster_name}-subnet"
  ip_cidr_range = var.vpc_cidr
  region        = var.region
  network       = google_compute_network.main.id
}

resource "google_container_cluster" "main" {
  name     = var.cluster_name
  location = var.zone

  # Remove default node pool immediately; manage nodes via google_container_node_pool
  remove_default_node_pool = true
  initial_node_count       = 1

  network    = google_compute_network.main.name
  subnetwork = google_compute_subnetwork.main.name

  # Standard mode required for hostNetwork: true on pods
  deletion_protection = false
}

# ── Control-plane node pool ───────────────────────────────────────────────────
# n2-standard-4 (4 vCPU / 16 GB), fixed at 2 nodes, no autoscaling.
# Runs: control-plane, Prometheus, Grafana, driver Jobs.

resource "google_container_node_pool" "control_plane" {
  name       = "${var.cluster_name}-control-plane"
  location   = var.zone
  cluster    = google_container_cluster.main.name

  node_count = 2

  node_config {
    machine_type = "n2-standard-4"
    disk_size_gb = 100
    disk_type    = "pd-ssd"

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    labels = merge(var.labels, {
      "node-pool" = "control-plane"
    })

    metadata = {
      disable-legacy-endpoints = "true"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

# ── Benchmark-worker node pool ────────────────────────────────────────────────
# n2-standard-16 (16 vCPU / 64 GB), autoscales 0–20.
# Tainted dedicated=benchmark:NO_SCHEDULE so only omb-worker pods land here.

resource "google_container_node_pool" "benchmark_workers" {
  name     = "${var.cluster_name}-benchmark-workers"
  location = var.zone
  cluster  = google_container_cluster.main.name

  initial_node_count = 2

  autoscaling {
    min_node_count = 0
    max_node_count = 20
  }

  node_config {
    machine_type = "n2-standard-16"
    disk_size_gb = 100
    disk_type    = "pd-ssd"

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    labels = merge(var.labels, {
      "node-pool" = "worker"
    })

    taint {
      key    = "dedicated"
      value  = "benchmark"
      effect = "NO_SCHEDULE"
    }

    metadata = {
      disable-legacy-endpoints = "true"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

resource "google_compute_network_peering" "to_target" {
  count = var.target_network != "" ? 1 : 0

  name         = "${var.cluster_name}-to-target"
  network      = google_compute_network.main.self_link
  peer_network = var.target_network
}

resource "google_compute_firewall" "omb_workers_8080" {
  name    = "${var.cluster_name}-omb-8080"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }

  # Allow intra-subnet (worker-to-worker) and from peered target if configured
  source_ranges = compact([
    var.vpc_cidr,
    var.target_cidr,
  ])
}
```

- [ ] **Step 2: Validate the Terraform**

```bash
cd terraform/gcp && terraform validate
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add terraform/gcp/main.tf
git commit -m "feat(gcp): split GKE into control-plane and benchmark-worker node pools"
```

---

## Task 4: Azure AKS — rename default pool and add benchmark-worker pool

**Files:**
- Modify: `terraform/azure/main.tf`

### Background

AKS requires exactly one `default_node_pool` inside the `azurerm_kubernetes_cluster` resource. The current pool is named `workers` (Standard_D16s_v3). After this task, the default pool becomes `controlplane` (Standard_D4s_v3, 4 vCPU / 16 GB, fixed 2), and a separate `azurerm_kubernetes_cluster_node_pool` resource provides the benchmark-worker pool (Standard_D16s_v3, autoscales 0–20, tainted).

**⚠ DESTRUCTIVE ON EXISTING CLUSTERS:** Renaming `default_node_pool.name` from `workers` to `controlplane` forces Terraform to destroy and recreate the entire AKS cluster. This is acceptable for fresh per-engagement deployments. Any existing cluster must be torn down and redeployed.

Azure `node_taints` format uses Kubernetes camelCase: `"key=value:Effect"`.
Azure node pool names must be alphanumeric, lowercase, ≤ 12 characters.

- [ ] **Step 1: Replace the entire contents of `terraform/azure/main.tf`**

```hcl
resource "azurerm_resource_group" "main" {
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

resource "azurerm_virtual_network" "main" {
  name                = "${var.cluster_name}-vnet"
  address_space       = var.vnet_address_space
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}

resource "azurerm_subnet" "aks" {
  name                 = "${var.cluster_name}-aks-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [var.subnet_address_prefix]
}

resource "azurerm_network_security_group" "omb_workers" {
  name                = "${var.cluster_name}-omb-nsg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags

  security_rule {
    name                       = "allow-omb-8080-inbound"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "8080"
    source_address_prefix      = var.subnet_address_prefix
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "aks" {
  subnet_id                 = azurerm_subnet.aks.id
  network_security_group_id = azurerm_network_security_group.omb_workers.id
}

resource "azurerm_kubernetes_cluster" "main" {
  name                = var.cluster_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = var.cluster_name
  tags                = var.tags

  # ── Control-plane node pool ─────────────────────────────────────────────────
  # Standard_D4s_v3 (4 vCPU / 16 GB), fixed at 2 nodes.
  # Runs: control-plane, Prometheus, Grafana, driver Jobs.
  # NOTE: renaming this pool from the previous value forces cluster replacement.
  default_node_pool {
    name                = "controlplane"
    vm_size             = "Standard_D4s_v3"
    node_count          = 2
    enable_auto_scaling = false
    vnet_subnet_id      = azurerm_subnet.aks.id

    node_labels = {
      "node-pool" = "control-plane"
    }
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin = "azure"
    service_cidr   = "10.100.0.0/16"
    dns_service_ip = "10.100.0.10"
  }
}

# ── Benchmark-worker node pool ────────────────────────────────────────────────
# Standard_D16s_v3 (16 vCPU / 64 GB), autoscales 0–20.
# Tainted dedicated=benchmark:NoSchedule so only omb-worker pods land here.

resource "azurerm_kubernetes_cluster_node_pool" "benchmark_workers" {
  name                  = "workers"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.main.id
  vm_size               = "Standard_D16s_v3"
  min_count             = 0
  max_count             = 20
  node_count            = 2
  enable_auto_scaling   = true
  vnet_subnet_id        = azurerm_subnet.aks.id

  node_labels = {
    "node-pool" = "worker"
  }

  node_taints = ["dedicated=benchmark:NoSchedule"]

  tags = var.tags
}

resource "azurerm_virtual_network_peering" "to_target" {
  count = var.target_vnet_id != "" ? 1 : 0

  name                      = "${var.cluster_name}-to-target"
  resource_group_name       = azurerm_resource_group.main.name
  virtual_network_name      = azurerm_virtual_network.main.name
  remote_virtual_network_id = var.target_vnet_id
  allow_forwarded_traffic   = true
}
```

- [ ] **Step 2: Validate the Terraform**

```bash
cd terraform/azure && terraform validate
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add terraform/azure/main.tf
git commit -m "feat(azure): split AKS into control-plane and benchmark-worker node pools"
```

---

## Task 5: Helm — worker StatefulSet: nodeSelector + toleration

**Files:**
- Modify: `charts/omb/templates/worker/statefulset.yaml`

### Background

Worker pods need `nodeSelector: { node-pool: worker }` to land on the tainted pool, plus `tolerations` matching the `dedicated=benchmark:NoSchedule` taint. The existing `podAntiAffinity` (one pod per node, required) must remain — do not remove it.

- [ ] **Step 1: Open `charts/omb/templates/worker/statefulset.yaml` and verify anti-affinity is present**

The file must contain:
```yaml
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: omb-worker
              topologyKey: kubernetes.io/hostname
```

It already exists. Do not remove it.

- [ ] **Step 2: Add `nodeSelector` and `tolerations` to the pod spec**

The complete updated file (replace entire file):

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: omb-worker
  labels:
    app: omb-worker
spec:
  serviceName: omb-worker
  replicas: {{ .Values.worker.replicas }}
  selector:
    matchLabels:
      app: omb-worker
  template:
    metadata:
      labels:
        app: omb-worker
    spec:
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      nodeSelector:
        node-pool: worker
      tolerations:
        - key: dedicated
          operator: Equal
          value: benchmark
          effect: NoSchedule
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: omb-worker
              topologyKey: kubernetes.io/hostname
      containers:
        - name: worker
          image: "{{ .Values.worker.image.repository }}:{{ .Values.worker.image.tag }}"
          imagePullPolicy: Always
          env:
            - name: OMB_MODE
              value: worker
          ports:
            - containerPort: 8080
              name: worker
          resources:
            requests:
              cpu: "4"
              memory: 8Gi
            limits:
              cpu: "4"
              memory: 8Gi
```

- [ ] **Step 3: Render and verify the StatefulSet output contains nodeSelector and toleration**

```bash
helm template omb charts/omb/ | grep -A 5 "nodeSelector" | head -20
```

Expected output includes:
```
      nodeSelector:
        node-pool: worker
```

```bash
helm template omb charts/omb/ | grep -A 5 "tolerations" | head -20
```

Expected output includes:
```
        - key: dedicated
          operator: Equal
          value: benchmark
          effect: NoSchedule
```

- [ ] **Step 4: Commit**

```bash
git add charts/omb/templates/worker/statefulset.yaml
git commit -m "feat(helm): add nodeSelector and toleration to worker StatefulSet"
```

---

## Task 6: Helm — control-plane Deployment: nodeSelector

**Files:**
- Modify: `charts/omb/templates/control-plane/deployment.yaml`

- [ ] **Step 1: Add `nodeSelector` to the pod spec in `charts/omb/templates/control-plane/deployment.yaml`**

Insert after `serviceAccountName: omb-control-plane`:

```yaml
      nodeSelector:
        node-pool: control-plane
```

The complete updated file:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: omb-control-plane
  labels:
    app: omb-control-plane
spec:
  replicas: 1
  selector:
    matchLabels:
      app: omb-control-plane
  template:
    metadata:
      labels:
        app: omb-control-plane
    spec:
      serviceAccountName: omb-control-plane
      nodeSelector:
        node-pool: control-plane
      containers:
        - name: control-plane
          image: "{{ .Values.controlPlane.image.repository }}:{{ .Values.controlPlane.image.tag }}"
          imagePullPolicy: Always
          ports:
            - containerPort: 8000
          env:
            - name: OMB_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: WORKER_IMAGE
              value: "{{ .Values.worker.image.repository }}:{{ .Values.worker.image.tag }}"
            - name: OMB_DB_PATH
              value: /data/omb_ui.db
            - name: PORT
              value: "8000"
            - name: PROMETHEUS_URL
              value: "http://{{ .Release.Name }}-kube-prometheus-stack-prometheus.{{ .Release.Namespace }}.svc.cluster.local:9090"
            {{- if .Values.controlPlane.encryptionKey }}
            - name: ENCRYPTION_KEY
              valueFrom:
                secretKeyRef:
                  name: omb-control-plane-encryption
                  key: encryption-key
            {{- end }}
          volumeMounts:
            - name: data
              mountPath: /data
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: "1"
              memory: 1Gi
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: omb-control-plane-data
```

- [ ] **Step 2: Verify the rendered output**

```bash
helm template omb charts/omb/ | grep -A 20 "name: omb-control-plane" | grep "node-pool"
```

Expected: `        node-pool: control-plane`

- [ ] **Step 3: Commit**

```bash
git add charts/omb/templates/control-plane/deployment.yaml
git commit -m "feat(helm): pin control-plane deployment to control-plane node pool"
```

---

## Task 7: Helm — Cluster Autoscaler Deployment: nodeSelector

**Files:**
- Modify: `charts/omb/templates/cluster-autoscaler/deployment.yaml`

The Cluster Autoscaler binary itself must run on a control-plane node, not on the benchmark workers it manages.

- [ ] **Step 1: Add `nodeSelector` to the pod spec in the Cluster Autoscaler Deployment**

Insert `nodeSelector` after `serviceAccountName: cluster-autoscaler`. The Deployment spec block (from `spec:` inside the Deployment down to the first `---`) becomes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
  labels:
    app: cluster-autoscaler
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cluster-autoscaler
  template:
    metadata:
      labels:
        app: cluster-autoscaler
      annotations:
        cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
    spec:
      serviceAccountName: cluster-autoscaler
      nodeSelector:
        node-pool: control-plane
      containers:
        - name: cluster-autoscaler
          image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.29.0
          command:
            - ./cluster-autoscaler
            - --v=4
            - --stderrthreshold=info
            - --cloud-provider=aws
            - --skip-nodes-with-local-storage=false
            - --expander=least-waste
            - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/{{ .Values.clusterAutoscaler.clusterName }}
            - --balance-similar-node-groups
            - --skip-nodes-with-system-pods=false
          env:
            - name: AWS_REGION
              value: {{ .Values.clusterAutoscaler.region }}
          resources:
            requests:
              cpu: 100m
              memory: 300Mi
            limits:
              cpu: 100m
              memory: 300Mi
          volumeMounts:
            - name: ssl-certs
              mountPath: /etc/ssl/certs/ca-certificates.crt
              readOnly: true
      volumes:
        - name: ssl-certs
          hostPath:
            path: /etc/ssl/certs/ca-bundle.crt
```

The rest of the file (ServiceAccount, ClusterRole, ClusterRoleBinding, Role, RoleBinding) is unchanged. Replace only the Deployment section.

Full updated file:

```yaml
{{- if .Values.clusterAutoscaler.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
  labels:
    app: cluster-autoscaler
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cluster-autoscaler
  template:
    metadata:
      labels:
        app: cluster-autoscaler
      annotations:
        cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
    spec:
      serviceAccountName: cluster-autoscaler
      nodeSelector:
        node-pool: control-plane
      containers:
        - name: cluster-autoscaler
          image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.29.0
          command:
            - ./cluster-autoscaler
            - --v=4
            - --stderrthreshold=info
            - --cloud-provider=aws
            - --skip-nodes-with-local-storage=false
            - --expander=least-waste
            - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/{{ .Values.clusterAutoscaler.clusterName }}
            - --balance-similar-node-groups
            - --skip-nodes-with-system-pods=false
          env:
            - name: AWS_REGION
              value: {{ .Values.clusterAutoscaler.region }}
          resources:
            requests:
              cpu: 100m
              memory: 300Mi
            limits:
              cpu: 100m
              memory: 300Mi
          volumeMounts:
            - name: ssl-certs
              mountPath: /etc/ssl/certs/ca-certificates.crt
              readOnly: true
      volumes:
        - name: ssl-certs
          hostPath:
            path: /etc/ssl/certs/ca-bundle.crt
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cluster-autoscaler
  namespace: kube-system
  labels:
    app: cluster-autoscaler
  annotations:
    eks.amazonaws.com/role-arn: {{ .Values.clusterAutoscaler.roleArn }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cluster-autoscaler
  labels:
    app: cluster-autoscaler
rules:
  - apiGroups: [""]
    resources: ["events", "endpoints"]
    verbs: ["create", "patch"]
  - apiGroups: [""]
    resources: ["pods/eviction"]
    verbs: ["create"]
  - apiGroups: [""]
    resources: ["pods/status"]
    verbs: ["update"]
  - apiGroups: [""]
    resources: ["endpoints"]
    resourceNames: ["cluster-autoscaler"]
    verbs: ["get", "update"]
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["watch", "list", "get", "update"]
  - apiGroups: [""]
    resources: ["namespaces", "pods", "services", "replicationcontrollers", "persistentvolumeclaims", "persistentvolumes"]
    verbs: ["watch", "list", "get"]
  - apiGroups: ["extensions"]
    resources: ["replicasets", "daemonsets"]
    verbs: ["watch", "list", "get"]
  - apiGroups: ["policy"]
    resources: ["poddisruptionbudgets"]
    verbs: ["watch", "list"]
  - apiGroups: ["apps"]
    resources: ["statefulsets", "replicasets", "daemonsets"]
    verbs: ["watch", "list", "get"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["storageclasses", "csinodes", "csidrivers", "csistoragecapacities"]
    verbs: ["watch", "list", "get"]
  - apiGroups: ["batch", "extensions"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["create"]
  - apiGroups: ["coordination.k8s.io"]
    resourceNames: ["cluster-autoscaler"]
    resources: ["leases"]
    verbs: ["get", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cluster-autoscaler
  labels:
    app: cluster-autoscaler
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-autoscaler
subjects:
  - kind: ServiceAccount
    name: cluster-autoscaler
    namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: cluster-autoscaler
  namespace: kube-system
  labels:
    app: cluster-autoscaler
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["create", "list", "watch"]
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["cluster-autoscaler-status", "cluster-autoscaler-priority-expander"]
    verbs: ["delete", "get", "update", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: cluster-autoscaler
  namespace: kube-system
  labels:
    app: cluster-autoscaler
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: cluster-autoscaler
subjects:
  - kind: ServiceAccount
    name: cluster-autoscaler
    namespace: kube-system
{{- end }}
```

- [ ] **Step 2: Verify the rendered output (requires clusterAutoscaler.enabled=true)**

```bash
helm template omb charts/omb/ --set clusterAutoscaler.enabled=true --set clusterAutoscaler.clusterName=test --set clusterAutoscaler.region=us-east-1 --set clusterAutoscaler.roleArn=arn:aws:iam::123456789012:role/test | grep -A 3 "name: cluster-autoscaler" | grep "node-pool"
```

Expected: `        node-pool: control-plane`

- [ ] **Step 3: Commit**

```bash
git add charts/omb/templates/cluster-autoscaler/deployment.yaml
git commit -m "feat(helm): pin cluster-autoscaler to control-plane node pool"
```

---

## Task 8: Helm — driver Job template: nodeSelector + resource requests

**Files:**
- Modify: `charts/omb/templates/jobs/driver-job.yaml`

### Background

The driver Job is a short-lived orchestrator pod — it does not run the benchmark workload itself, it drives the workers. It should run on the control-plane pool and carry lightweight resource requests (500m CPU / 512Mi memory) so the Kubernetes scheduler can place it without over-committing the node.

- [ ] **Step 1: Replace the entire contents of `charts/omb/templates/jobs/driver-job.yaml`**

```yaml
{{- /*
RUNTIME TEMPLATE — NOT MANAGED BY HELM

This file is intentionally never rendered by Helm (driverJob.enabled is always false).
It exists as the reference template the control plane uses at runtime to construct
Job manifests via the Kubernetes API.

The control plane reads this template and substitutes these markers before submitting:
  __JOB_NAME__       — unique run ID
  __CONFIGMAP_NAME__ — ConfigMap created for this run
  __WORKERS_ARG__    — comma-separated worker URLs constructed from replica count

Do not set driverJob.enabled: true. This is not a Helm-managed resource.
*/ -}}
{{- if .Values.driverJob.enabled }}
apiVersion: batch/v1
kind: Job
metadata:
  name: __JOB_NAME__
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      restartPolicy: Never
      nodeSelector:
        node-pool: control-plane
      containers:
        - name: driver
          image: "{{ .Values.worker.image.repository }}:{{ .Values.worker.image.tag }}"
          imagePullPolicy: Always
          env:
            - name: OMB_MODE
              value: driver
          args:
            - --drivers
            - /etc/omb/driver.yaml
            - /etc/omb/workload.yaml
            - --workers
            - __WORKERS_ARG__
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
          volumeMounts:
            - name: omb-config
              mountPath: /etc/omb
      volumes:
        - name: omb-config
          configMap:
            name: __CONFIGMAP_NAME__
{{- end }}
```

- [ ] **Step 2: Commit**

```bash
git add charts/omb/templates/jobs/driver-job.yaml
git commit -m "feat(helm): pin driver Job to control-plane pool; add resource requests"
```

---

## Task 9: Helm — Prometheus/Grafana/Operator: nodeSelector + node-exporter toleration

**Files:**
- Modify: `charts/omb/values.yaml`

### Background

kube-prometheus-stack is a subchart. Pod placement for each component is configured via subchart values in `values.yaml`. Node-exporter is a DaemonSet that must run on ALL nodes to collect host metrics — including the tainted benchmark worker nodes. It cannot have a nodeSelector, but it must tolerate the worker taint so it is not blocked from those nodes.

- [ ] **Step 1: Replace the entire contents of `charts/omb/values.yaml`**

```yaml
worker:
  replicas: 2
  image:
    repository: ghcr.io/supahcraig/omb-worker
    tag: latest

controlPlane:
  image:
    repository: ghcr.io/supahcraig/omb-control-plane
    tag: latest
  # Fernet encryption key for passwords at rest (base64-encoded 32-byte key).
  # Generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
  # If empty, an ephemeral key is generated at startup — passwords will not
  # survive pod restarts. Set this before saving any credentials.
  encryptionKey: ""

storage:
  storageClassName: ""
  size: 10Gi
  createStorageClass: false

prometheus:
  enabled: true

clusterAutoscaler:
  enabled: false
  clusterName: ""
  region: ""
  roleArn: ""

driverJob:
  enabled: false

# kube-prometheus-stack subchart values
kube-prometheus-stack:
  alertmanager:
    enabled: false
  prometheus:
    prometheusSpec:
      nodeSelector:
        node-pool: control-plane
      additionalScrapeConfigsSecret:
        enabled: true
        name: omb-prometheus-additional-scrape-configs
        key: additional-scrape-configs.yaml
      resources:
        requests:
          cpu: 200m
          memory: 512Mi
        limits:
          cpu: 500m
          memory: 1Gi
      retention: 6h
  grafana:
    nodeSelector:
      node-pool: control-plane
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 200m
        memory: 256Mi
    adminPassword: admin
  prometheusOperator:
    nodeSelector:
      node-pool: control-plane
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 200m
        memory: 256Mi
  kube-state-metrics:
    nodeSelector:
      node-pool: control-plane
    resources:
      requests:
        cpu: 10m
        memory: 32Mi
      limits:
        cpu: 100m
        memory: 64Mi
  prometheus-node-exporter:
    # DaemonSet — no nodeSelector, must run on all nodes including tainted workers.
    tolerations:
      - key: dedicated
        operator: Equal
        value: benchmark
        effect: NoSchedule
    resources:
      requests:
        cpu: 10m
        memory: 32Mi
      limits:
        cpu: 100m
        memory: 64Mi
```

- [ ] **Step 2: Render and verify nodeSelector appears for prometheus**

```bash
helm template omb charts/omb/ | grep -B 2 "node-pool: control-plane" | head -40
```

Expected: multiple blocks showing `node-pool: control-plane` under prometheus, grafana, prometheusOperator, kube-state-metrics.

- [ ] **Step 3: Verify node-exporter toleration appears**

```bash
helm template omb charts/omb/ | grep -A 5 "dedicated" | head -20
```

Expected output includes the worker StatefulSet toleration AND the node-exporter toleration.

- [ ] **Step 4: Commit**

```bash
git add charts/omb/values.yaml
git commit -m "feat(helm): pin prometheus stack to control-plane pool; add node-exporter worker taint toleration"
```

---

## Task 10: Update CLAUDE.md with dual-pool decisions

**Files:**
- Modify: `CLAUDE.md`

Add the following block to the "Key design decisions" section (after the existing entry about `dnsPolicy: ClusterFirstWithHostNet`):

- [ ] **Step 1: Add dual-pool design decision block**

Insert after the `**Worker pods require \`dnsPolicy: ClusterFirstWithHostNet\`.**` paragraph and before the `**GKE uses Standard mode, not Autopilot.**` paragraph:

```markdown
**The cluster is split into two node pools: control-plane and benchmark-worker.**
The control-plane pool runs everything except omb-worker pods: control-plane app,
Prometheus, Grafana, Cluster Autoscaler, and driver Jobs. The benchmark-worker pool
runs only omb-worker pods. Pool sizes:

| Cloud | Control-plane pool | Benchmark-worker pool |
|-------|-------------------|----------------------|
| AWS   | m5.xlarge, fixed 2 | m5.4xlarge, 0–20 |
| GCP   | n2-standard-4, fixed 2 | n2-standard-16, 0–20 |
| Azure | Standard_D4s_v3, fixed 2 | Standard_D16s_v3, 0–20 |

Nodes are labeled `node-pool: control-plane` or `node-pool: worker`. Worker nodes
carry a `dedicated=benchmark:NoSchedule` taint so non-worker pods cannot land on
them without an explicit toleration. Every Helm workload has a matching `nodeSelector`.
The worker StatefulSet also has a `tolerations` entry for the benchmark taint.
node-exporter is a DaemonSet that runs on all nodes and carries a toleration for
the worker taint so it can collect host metrics from benchmark nodes.
Driver Jobs run on the control-plane pool — they orchestrate the benchmark but do
not execute it. Resource requests for driver Jobs: 500m CPU / 512Mi memory.

**Azure AKS note:** Renaming `default_node_pool` from `workers` to `controlplane`
forces destruction and recreation of the entire AKS cluster. Re-deploy fresh;
do not attempt in-place upgrade of an existing AKS engagement cluster.
```

- [ ] **Step 2: Verify the section looks correct**

```bash
grep -A 5 "split into two node pools" CLAUDE.md
```

Expected: the new paragraph appears.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document dual node pool architecture in CLAUDE.md"
```

---

## Task 11: Final validation

This task has no code changes. It documents the runtime validation commands an SE would run after `helm install` to confirm correct pod placement.

- [ ] **Step 1: Verify all changes render cleanly**

```bash
helm template omb charts/omb/ -f charts/omb/values-aws.yaml > /dev/null && echo "OK"
helm template omb charts/omb/ -f charts/omb/values-gcp.yaml > /dev/null && echo "OK"
helm template omb charts/omb/ -f charts/omb/values-aks.yaml > /dev/null && echo "OK"
```

Expected: `OK` for each cloud values file.

- [ ] **Step 2: Validate all three Terraform modules**

```bash
(cd terraform/aws && terraform validate) && \
(cd terraform/gcp && terraform validate) && \
(cd terraform/azure && terraform validate)
```

Expected: `Success! The configuration is valid.` for all three.

- [ ] **Step 3: Record the runtime kubectl validation commands (for post-deploy verification)**

After `helm install` against a real cluster, run:

```bash
# Confirm pods land on correct node pools
kubectl get pods -o wide -n omb

# Confirm worker nodes are tainted
kubectl get nodes -l node-pool=worker -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints

# Confirm no two worker pods share a node
kubectl get pods -l app=omb-worker -o wide -n omb

# Confirm control-plane pod is on a control-plane node
kubectl get pod -l app=omb-control-plane -o wide -n omb
```

Expected: all `omb-worker-*` pods on different `node-pool=worker` nodes; `omb-control-plane-*` on a `node-pool=control-plane` node.

- [ ] **Step 4: Commit final state check**

```bash
git status
```

Expected: clean working tree (all committed).

---

## Self-Review

### Spec Coverage

| Spec requirement | Task |
|---|---|
| Control-plane pool: m5.xlarge, fixed 2, label node-pool=control-plane | Task 2 (AWS), Task 3 (GCP), Task 4 (Azure) |
| Worker pool: m5.4xlarge, autoscales 0–20, label node-pool=worker, taint dedicated=benchmark:NoSchedule | Task 2 (AWS), Task 3 (GCP), Task 4 (Azure) |
| Worker StatefulSet: nodeSelector + toleration | Task 5 |
| Worker StatefulSet: pod anti-affinity present | Task 5 (verified, unchanged) |
| Control-plane nodeSelector | Task 6 |
| Prometheus/Grafana nodeSelector | Task 9 |
| Cluster Autoscaler nodeSelector | Task 7 |
| Driver Job nodeSelector on control-plane pool | Task 8 |
| Driver Job resource requests (500m / 512Mi) | Task 8 |
| Update CLAUDE.md | Task 10 |
| Validate with kubectl get pods -o wide | Task 11 |

### Gaps noted

- GCP and Azure do not use the Helm-deployed Cluster Autoscaler (they use their cloud-native autoscaler). The Cluster Autoscaler `nodeSelector` in Task 7 is AWS-only but harmless on GCP/AKS since that Deployment is gated behind `clusterAutoscaler.enabled: true` which is only set in `values-aws.yaml`.
- Prometheus/Grafana PVC placement: PVCs are not node-bound on any cloud (they are zone-bound on single-AZ deployments). No change required.
