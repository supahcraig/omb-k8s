# omb Helm Chart

Deploys the OpenMessaging Benchmark platform on Kubernetes.

## Install

```bash
# AWS
helm install omb charts/omb \
  -f charts/omb/values-aws.yaml \
  --set clusterAutoscaler.clusterName=<eks-cluster-name> \
  --set clusterAutoscaler.region=<aws-region> \
  --set clusterAutoscaler.roleArn=<output from terraform: cluster_autoscaler_iam_role_arn>

# GCP
helm install omb charts/omb -f charts/omb/values-gcp.yaml

# Azure
helm install omb charts/omb -f charts/omb/values-aks.yaml
```

## Validation

After install, run these checks in order.

### 1. All pods reach Running/Ready state

```bash
kubectl get pods -n <namespace>
```

Expected: control-plane pod Running, 2× omb-worker pods Running, prometheus/grafana pods Running.

### 2. Worker pods have stable DNS

Exec into any running pod and verify worker-0 is reachable by its stable DNS name:

```bash
kubectl exec -it <any-running-pod> -n <namespace> -- \
  curl http://omb-worker-0.omb-worker.<namespace>.svc.cluster.local:8080
```

Expected: HTTP 200 response from the OMB worker HTTP interface.

### 3. PVC is bound

```bash
kubectl get pvc -n <namespace>
```

Expected: `omb-control-plane-data` shows `STATUS: Bound`.

### 4. RBAC resources exist and are correctly configured

```bash
kubectl get serviceaccount,role,rolebinding -n <namespace>
```

Expected: `omb-control-plane` ServiceAccount, Role, and RoleBinding all present.

### 5. Control plane service has an external IP

```bash
kubectl get svc -n <namespace>
```

Expected: `omb-control-plane` service shows a populated `EXTERNAL-IP` (may take 1-2 minutes for the load balancer to provision).

### 6. Prometheus and Grafana pods are running

```bash
kubectl get pods -n <namespace> | grep -E 'prometheus|grafana'
```

Expected: prometheus and grafana pods in `Running` state.

## Uninstall

```bash
helm uninstall omb
```

> **Note:** The PVC is not deleted automatically. Delete it manually if you want to discard benchmark data:
> ```bash
> kubectl delete pvc omb-control-plane-data -n <namespace>
> ```

## Scaling workers

Scale workers via the control plane UI. Do not edit the StatefulSet replica count
directly with kubectl — the control plane tracks the replica count and will
construct incorrect `--workers` arguments if out of sync.

## Adding more throughput

The correct response to needing more throughput is adding more worker pods via
the UI scaling control, not changing instance types or JVM settings. Each node
fits ~8 worker pods before the Cluster Autoscaler adds a new node.
