# In-cluster Redpanda deployment

Deploys Redpanda into the **same** EKS cluster as OMB, onto the dedicated
`r8gd.8xlarge` node pool provisioned by `terraform/aws/redpanda.tf`
(label `node-pool=redpanda`, taint `redpanda-tuned=true:NoSchedule`, local NVMe
formatted + mounted at `/mnt/redpanda`).

Deployed via the **Redpanda operator** with **cert-manager** (TLS) and a
**SASL SCRAM-SHA-256** superuser. Storage is local NVMe via `local-path`.

## Prerequisites

- EKS cluster up (`terraform/aws apply`) and `KUBECONFIG` pointed at it.
- cert-manager installed (`jetstack/cert-manager`, `crds.enabled=true`).
- Redpanda operator installed (`redpanda/operator` v26.1.7, `crds.enabled=true`)
  in the `redpanda` namespace.

## Steps

### 1. local-path-provisioner on the NVMe mount

```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.31/deploy/local-path-storage.yaml
kubectl apply -f redpanda-deploy/local-path-config.yaml           # NVMe path + taint toleration
kubectl -n local-path-storage rollout restart deploy/local-path-provisioner
```

### 2. SASL superuser secret (keeps the password out of git)

```bash
RP_PW=$(openssl rand -base64 24)
kubectl -n redpanda create secret generic redpanda-users \
  --from-literal=superuser="${RP_PW}:SCRAM-SHA-256"
```

The `redpanda-users` Secret format is `username=<password>:<mechanism>`.

### 2b. Operator CA secret (required when using a custom TLS issuer)

The Redpanda **operator** builds its admin client from a secret hardcoded as
`redpanda-default-root-certificate`. When the CR pins a custom
`tls.certs.default.issuerRef` (our `redpanda-ca`), the chart does NOT create that
secret, so every operator reconcile fails with
`error fetching server root CA ... server TLS certificate not found` — and no CR
change (e.g. `resources.cpu.cores` / `--smp`) ever reaches the StatefulSet.

Fix: after the root CA exists, copy it into the operator-expected name:

```bash
kubectl -n redpanda get secret redpanda-root-ca -o json \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);d["metadata"]={"name":"redpanda-default-root-certificate","namespace":"redpanda"};d.pop("status",None);print(json.dumps(d))' \
  | kubectl apply -f -
```

### 3. Deploy the Redpanda cluster

```bash
kubectl apply -f redpanda-deploy/redpanda-cluster.yaml
kubectl -n redpanda get redpanda -w        # wait for READY=True
```

### 4. Trust root → OMB

The chart's cert-manager CA lands in Secret `redpanda-default-root-certificate`
(`ca.crt`). OMB ships `commonConfig` to every worker, and its Settings API turns
`tls_ca_cert` into an inline-PEM truststore — so pasting the CA into Settings is
all that's needed for every worker to trust the brokers.

```bash
CA=$(kubectl -n redpanda get secret redpanda-default-root-certificate -o jsonpath='{.data.ca\.crt}' | base64 -d)
```

Then POST to the OMB control-plane `/api/settings` (or use the UI Settings →
Cluster tab):

| Field           | Value                                              |
|-----------------|----------------------------------------------------|
| bootstrap_servers | `redpanda.redpanda.svc.cluster.local:9093`       |
| tls_enabled     | `true`                                             |
| tls_ca_cert     | the `ca.crt` PEM above                             |
| sasl_enabled    | `true`                                             |
| sasl_mechanism  | `SCRAM-SHA-256`                                    |
| sasl_username   | `superuser`                                        |
| sasl_password   | value of `$RP_PW`                                  |
