Read CLAUDE.md fully before doing anything else.

This is session 3 of 6. Your deliverable is a working Helm chart in charts/omb/ 
that deploys all components and validates correctly against a real cluster.

This is the most important session — if the chart is wrong, nothing else works. 
Take your time and get the component interactions right before moving on.

## Chart structure

charts/omb/
  Chart.yaml
  values.yaml              base values, cloud-agnostic
  values-aws.yaml          AWS overrides only
  values-gcp.yaml          GCP overrides only  
  values-aks.yaml          Azure overrides only
  templates/
    control-plane/
      deployment.yaml
      service.yaml
      pvc.yaml
    worker/
      statefulset.yaml
      service.yaml         headless service
    rbac/
      serviceaccount.yaml
      role.yaml
      rolebinding.yaml
    jobs/
      driver-job.yaml      template only, created at runtime by control plane
  charts/                  subchart dependencies

## Component specifications

### control-plane
- Deployment, 1 replica
- Image: ghcr.io/[org]/omb-control-plane:latest (overridable in values)
- Resources: requests 500m CPU / 512Mi memory, limits 1 CPU / 1Gi memory
- PVC mount at /data (SQLite lives here)
- Service: LoadBalancer (port 80 → container 8000)
- ServiceAccount: omb-control-plane
- Env vars from values: OMB_NAMESPACE, OMB_WORKER_REPLICAS (initial count)
- hostNetwork: false

### omb-worker (StatefulSet — not Deployment)
- StatefulSet is required for stable pod DNS via headless Service
- Image: ghcr.io/[org]/omb-worker:latest (overridable in values)
- Env: OMB_MODE=worker
- Resources: requests 4 CPU / 8Gi memory, limits 4 CPU / 8Gi memory
  These are fixed. Do not make them values-configurable.
- hostNetwork: true
- Headless Service named omb-worker (clusterIP: None), port 8080
- Initial replicas: configurable in values.yaml (default 2)
- Pod DNS pattern this creates: 
  omb-worker-0.omb-worker.<namespace>.svc.cluster.local:8080

### RBAC
ServiceAccount: omb-control-plane
Role must permit:
- create, delete Jobs in the release namespace
- create, delete ConfigMaps in the release namespace
- get, patch StatefulSets (for scaling workers)
- get, list Pods (for worker status)
RoleBinding: binds the Role to the ServiceAccount

### Prometheus + Grafana
Use prometheus-community/kube-prometheus-stack as a subchart dependency.
Include in Chart.yaml dependencies with a pinned version.
Configure in values.yaml with minimal resource footprint appropriate for 
a short-lived engagement cluster.
Disable components not needed: alertmanager can be disabled by default.

### PVC
Storage: 10Gi (sufficient for SQLite across a multi-week engagement)
StorageClass: set in values.yaml as storageClassName: "" (uses cluster default)
Overridden in values-aws.yaml (gp3), values-gcp.yaml (standard), 
values-aks.yaml (managed-premium)

### driver-job template
This is a template file only — it is not deployed by Helm directly. It serves 
as the template the control plane uses to construct Job manifests at runtime.
Include it in charts/omb/templates/jobs/driver-job.yaml with clear comments 
indicating it is a runtime template, not a Helm-deployed resource.
Use a condition that always evaluates to false so Helm never deploys it:
{{- if .Values.driverJob.enabled }} with enabled: false in values.yaml

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

driverJob:
  enabled: false

## Validation steps

After helm install omb charts/omb -f charts/omb/values-aws.yaml:
1. All pods reach Running state
2. Worker pods have stable DNS: 
   kubectl exec -it <any-pod> -- curl http://omb-worker-0.omb-worker:8080
3. PVC is bound
4. ServiceAccount and Role exist and are correctly bound
5. Control plane service has an external IP

Document all validation steps in charts/omb/README.md with exact kubectl commands.

Do not touch the control plane code or UI. That is session 4 and 5.
