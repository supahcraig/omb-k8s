# Session 3 — Helm Chart

Read CLAUDE.md fully before doing anything else.

This is session 3 of 6. Your deliverable is a working Helm chart in charts/omb/
that deploys all components and validates correctly against a real cluster
provisioned in session 2.

This is the most important session — if the chart is wrong, nothing else works.
Take the time to get component interactions right before moving on.

## Chart structure

charts/omb/
  Chart.yaml
  values.yaml                 base values, cloud-agnostic
  values-aws.yaml             AWS overrides only
  values-gcp.yaml             GCP overrides only
  values-aks.yaml             Azure overrides only
  templates/
    control-plane/
      deployment.yaml
      service.yaml
      pvc.yaml
    worker/
      statefulset.yaml
      service.yaml            headless service
    rbac/
      serviceaccount.yaml
      role.yaml
      rolebinding.yaml
    cluster-autoscaler/
      deployment.yaml         AWS only, conditional on values
    jobs/
      driver-job.yaml         template only, never deployed by Helm directly
  charts/                     subchart dependencies

## Component specifications

### control-plane

- Deployment, 1 replica
- Image: ghcr.io/[org]/omb-control-plane:latest (overridable in values)
- Resources: requests 500m CPU / 512Mi memory, limits 1 CPU / 1Gi memory
- PVC mount at /data (SQLite lives here)
- Service: LoadBalancer (port 80 → container 8000)
- ServiceAccount: omb-control-plane
- hostNetwork: false
- Env vars (all configurable via values):
    OMB_NAMESPACE: release namespace
    OMB_WORKER_REPLICAS: initial worker count (default 2)
    OMB_DB_PATH: /data/omb_ui.db
    PORT: 8000

### omb-worker (StatefulSet — not Deployment, this is required)

Workers must be a StatefulSet to get stable, predictable pod DNS names via
the headless Service. This is non-negotiable — it is how the control plane
constructs the --workers argument without a service registry.

- Image: ghcr.io/[org]/omb-worker:latest (overridable in values)
- Env: OMB_MODE=worker
- Resources: requests 4 CPU / 8Gi memory, limits 4 CPU / 8Gi memory
  These are fixed. Do not make them values-configurable.
- hostNetwork: true
- Headless Service named omb-worker (clusterIP: None), port 8080
- Initial replicas: configurable in values.yaml (default 2)

The pod DNS pattern this creates (verify this works in validation):
  omb-worker-0.omb-worker.<namespace>.svc.cluster.local:8080
  omb-worker-1.omb-worker.<namespace>.svc.cluster.local:8080

### RBAC

ServiceAccount: omb-control-plane

Role must permit the following in the release namespace:
- Jobs: create, delete, get, list, watch
- ConfigMaps: create, delete, get, list
- StatefulSets: get, patch, update (for scaling workers)
- Pods: get, list, watch (for worker status and log streaming)

RoleBinding: binds the Role to the omb-control-plane ServiceAccount

### Prometheus + Grafana

Use prometheus-community/kube-prometheus-stack as a subchart dependency.
Pin to a specific version in Chart.yaml.
Configure in values.yaml with a minimal resource footprint appropriate for
a short-lived engagement cluster.
Disable alertmanager by default (not needed for benchmark sessions).

### PVC

- Storage: 10Gi
- StorageClass: set via values.yaml storageClassName (empty string uses
  cluster default)
- Overrides:
    values-aws.yaml:  storageClassName: gp3
    values-gcp.yaml:  storageClassName: standard
    values-aks.yaml:  storageClassName: managed-premium

### Cluster Autoscaler (AWS only)

- Conditional: only deployed when values.clusterAutoscaler.enabled is true
- Default true in values-aws.yaml, default false in values.yaml
- Requires from values:
    clusterAutoscaler.clusterName
    clusterAutoscaler.region
    clusterAutoscaler.roleArn  (output from EKS Terraform module)

### driver-job template

This file is a template only — it is never deployed by Helm directly.
It serves as the reference template the control plane uses at runtime to
construct Job manifests.

Use a condition that always evaluates to false so Helm never deploys it:
  {{- if .Values.driverJob.enabled }}
with driverJob.enabled: false in values.yaml.

Include clear comments at the top of the file explaining it is a runtime
template, not a Helm-managed resource.

The Job spec must:
- Use the worker image with OMB_MODE=driver
- Mount the driver ConfigMap at /etc/omb/
- Pass --drivers /etc/omb/driver.yaml and workload path as args
- Pass --workers as a constructed argument (control plane fills this in)
- Have a restart policy of Never
- Clean up automatically after completion (ttlSecondsAfterFinished: 300)

## values.yaml structure

worker:
  replicas: 2
  image:
    repository: ghcr.io/[org]/omb-worker
    tag: latest

controlPlane:
  image:
    repository: ghcr.io/[org]/omb-control-plane
    tag: latest

storage:
  storageClassName: ""
  size: 10Gi

prometheus:
  enabled: true

clusterAutoscaler:
  enabled: false
  clusterName: ""
  region: ""
  roleArn: ""

driverJob:
  enabled: false

## Validation steps

After helm install omb charts/omb -f charts/omb/values-aws.yaml:

1. All pods reach Running/Ready state:
   kubectl get pods -n <namespace>

2. Worker pods have stable DNS — exec into any pod and verify:
   kubectl exec -it <any-pod> -n <namespace> -- \
     curl http://omb-worker-0.omb-worker.<namespace>.svc.cluster.local:8080

3. PVC is bound:
   kubectl get pvc -n <namespace>

4. ServiceAccount, Role, and RoleBinding exist and are correctly configured:
   kubectl get serviceaccount,role,rolebinding -n <namespace>

5. Control plane service has an external IP:
   kubectl get svc -n <namespace>

6. Prometheus and Grafana pods are running:
   kubectl get pods -n <namespace> -l app=prometheus

Document all validation steps with exact kubectl commands in charts/omb/README.md.

Do not touch control plane code or UI. That is sessions 4 and 5.
